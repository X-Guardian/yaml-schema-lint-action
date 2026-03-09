/**
 * @typedef {object} Inputs
 * @property {object} github - Octokit instance provided by actions/github-script
 * @property {object} context - GitHub Actions context (repo, sha, payload, etc.)
 * @property {{ info: (msg: string) => void, setFailed: (msg: string) => void }} core - Actions core toolkit
 * @property {string}  reportPath - Path to the yaml-schema-lint JSON report file
 * @property {string}  checkName - Name displayed in the GitHub Checks tab
 * @property {boolean} failOnError - Whether to fail the check when errors are found
 * @property {boolean} failOnWarning - Whether to fail the check when warnings are found
 * @property {boolean} onlyPrFiles - Whether to limit annotations to PR-changed files
 * @property {boolean} stepSummary - Whether to write a markdown step summary
 */

/** @type {Record<string, string>} */
const SEVERITY_TO_LEVEL = {
  error: 'failure',
  warning: 'warning',
  information: 'notice',
  hint: 'notice',
};

/**
 * Read a yaml-schema-lint JSON report and create a GitHub Check Run.
 * @param {Inputs} inputs - Action inputs and injected helpers
 */
module.exports = async function createCheck({
  github,
  context,
  core,
  reportPath,
  checkName,
  failOnError,
  failOnWarning,
  onlyPrFiles,
  stepSummary,
}) {
  const fs = require('fs');

  if (!fs.existsSync(reportPath)) {
    core.setFailed(`Report file not found: ${reportPath}`);
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

  // Optionally filter to PR-changed files
  /** @type {Set<string> | null} */
  let prFiles = null;
  if (onlyPrFiles && context.payload.pull_request) {
    const pr = context.payload.pull_request;
    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    prFiles = new Set(files.map((/** @type {{ filename: string }} */ f) => f.filename));
  }

  // Build annotations
  /** @type {Array<{path: string, start_line: number, end_line: number, start_column: number, end_column: number, annotation_level: string, message: string, title: string}>} */
  const annotations = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const file of report) {
    if (prFiles && !prFiles.has(file.filePath)) continue;
    if (file.diagnostics.length === 0) continue;
    for (const diag of file.diagnostics) {
      if (diag.severity === 'error') errorCount++;
      else if (diag.severity === 'warning') warningCount++;

      annotations.push({
        path: file.filePath,
        start_line: diag.range.start.line,
        end_line: diag.range.end.line,
        start_column: diag.range.start.character,
        end_column: diag.range.end.character,
        annotation_level: SEVERITY_TO_LEVEL[diag.severity] || 'notice',
        message: diag.message,
        title: diag.source || 'yaml-lint',
      });
    }
  }

  // Determine conclusion
  let conclusion = 'success';
  if (errorCount > 0 && failOnError) conclusion = 'failure';
  else if (warningCount > 0 && failOnWarning) conclusion = 'failure';

  const title = `${errorCount} error(s) and ${warningCount} warning(s) found`;
  const summary = `${errorCount} error(s) and ${warningCount} warning(s) found${prFiles ? ' in pull request changed files' : ''}.`;

  // Markdown step summary
  if (stepSummary) {
    const md = [
      `# Pull Request Changed Files YAML Lint Results:`,
      '',
      `**${errorCount} error(s) and ${warningCount} warning(s) found**`,
    ];

    if (annotations.length > 0) {
      md.push('', '| File | Line | Severity | Message |', '|------|------|----------|---------|');
      for (const a of annotations) {
        md.push(`| \`${a.path}\` | ${a.start_line} | ${a.annotation_level} | ${a.message} |`);
      }
    }

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      fs.appendFileSync(summaryPath, md.join('\n') + '\n');
    }
  }

  // Create check run (batched, max 50 annotations per API call)
  const headSha = context.payload.pull_request ? context.payload.pull_request.head.sha : context.sha;

  const batchSize = 50;
  const firstBatch = annotations.slice(0, batchSize);

  const { data: checkRun } = await github.rest.checks.create({
    owner: context.repo.owner,
    repo: context.repo.repo,
    name: checkName,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output: {
      title,
      summary,
      annotations: firstBatch,
    },
  });

  for (let i = batchSize; i < annotations.length; i += batchSize) {
    await github.rest.checks.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      check_run_id: checkRun.id,
      output: {
        title,
        summary,
        annotations: annotations.slice(i, i + batchSize),
      },
    });
  }

  core.info(`Check "${checkName}" created with conclusion: ${conclusion}`);

  if (conclusion === 'failure') {
    core.setFailed(`${checkName}: ${errorCount} error(s), ${warningCount} warning(s)`);
  }
};
