const fs = require('fs');
const path = require('path');
const os = require('os');
const createCheck = require('./create-check');

/**
 * Build a minimal JSON report for testing.
 * @param {Array<{filePath: string, diagnostics: Array}>} files - Report file entries
 * @returns {string} Serialised JSON string
 */
function buildReport(files) {
  return JSON.stringify(files);
}

/**
 * Create a diagnostic entry matching the yaml-schema-lint JSON format.
 * @param {Partial<{message: string, severity: string, source: string, line: number, character: number}>} [overrides] - Optional field overrides
 * @returns {object} A diagnostic object
 */
function makeDiag(overrides = {}) {
  const line = overrides.line ?? 1;
  const character = overrides.character ?? 1;
  return {
    message: overrides.message ?? 'test error',
    severity: overrides.severity ?? 'error',
    source: overrides.source ?? 'yaml-schema',
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
  };
}

/**
 * @returns {object} A mock Octokit-like github object
 */
function mockGitHub() {
  return {
    rest: {
      checks: {
        create: jest.fn().mockResolvedValue({ data: { id: 42 } }),
        update: jest.fn().mockResolvedValue({}),
      },
      pulls: {
        listFiles: jest.fn(),
      },
    },
    paginate: jest.fn().mockResolvedValue([]),
  };
}

/**
 * @param {object} [overrides] - Optional context overrides
 * @returns {object} A mock GitHub Actions context
 */
function mockContext(overrides = {}) {
  return {
    sha: 'abc123',
    repo: { owner: 'test-owner', repo: 'test-repo' },
    payload: {
      pull_request: {
        number: 1,
        head: { sha: 'pr-head-sha' },
      },
    },
    ...overrides,
  };
}

/**
 * @returns {object} A mock actions/core toolkit
 */
function mockCore() {
  return {
    info: jest.fn(),
    setFailed: jest.fn(),
  };
}

/**
 * @param {object} [overrides] - Optional input overrides
 * @returns {object} Default inputs for createCheck
 */
function defaultInputs(overrides = {}) {
  return {
    github: mockGitHub(),
    context: mockContext(),
    core: mockCore(),
    reportPath: '/nonexistent/report.json',
    checkName: 'YAML Lint Report',
    failOnError: true,
    failOnWarning: false,
    onlyPrFiles: false,
    stepSummary: false,
    ...overrides,
  };
}

let tmpDir;
let reportPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-check-test-'));
  reportPath = path.join(tmpDir, 'report.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.GITHUB_STEP_SUMMARY;
});

describe('createCheck', () => {
  it('calls setFailed when report file does not exist', async () => {
    const inputs = defaultInputs();

    await createCheck(inputs);

    expect(inputs.core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Report file not found'));
    expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it('creates a check with success conclusion for a clean report', async () => {
    fs.writeFileSync(reportPath, buildReport([{ filePath: 'clean.yaml', diagnostics: [] }]));
    const inputs = defaultInputs({ reportPath });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'success',
        head_sha: 'pr-head-sha',
        output: expect.objectContaining({
          title: '0 error(s) and 0 warning(s) found',
          annotations: [],
        }),
      }),
    );
    expect(inputs.core.setFailed).not.toHaveBeenCalled();
  });

  it('creates a check with failure conclusion when errors found and failOnError is true', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([{ filePath: 'bad.yaml', diagnostics: [makeDiag({ severity: 'error' })] }]),
    );
    const inputs = defaultInputs({ reportPath, failOnError: true });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    expect(inputs.core.setFailed).toHaveBeenCalledWith(expect.stringContaining('1 error(s)'));
  });

  it('creates a check with success conclusion when errors found but failOnError is false', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([{ filePath: 'bad.yaml', diagnostics: [makeDiag({ severity: 'error' })] }]),
    );
    const inputs = defaultInputs({ reportPath, failOnError: false });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'success' }));
    expect(inputs.core.setFailed).not.toHaveBeenCalled();
  });

  it('fails on warnings when failOnWarning is true', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([{ filePath: 'warn.yaml', diagnostics: [makeDiag({ severity: 'warning' })] }]),
    );
    const inputs = defaultInputs({ reportPath, failOnWarning: true });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
  });

  it('does not fail on warnings when failOnWarning is false', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([{ filePath: 'warn.yaml', diagnostics: [makeDiag({ severity: 'warning' })] }]),
    );
    const inputs = defaultInputs({ reportPath, failOnWarning: false });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'success' }));
  });

  it('maps severity to correct annotation levels', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([
        {
          filePath: 'test.yaml',
          diagnostics: [
            makeDiag({ severity: 'error', message: 'err' }),
            makeDiag({ severity: 'warning', message: 'warn' }),
            makeDiag({ severity: 'information', message: 'info' }),
            makeDiag({ severity: 'hint', message: 'hint' }),
          ],
        },
      ]),
    );
    const inputs = defaultInputs({ reportPath });

    await createCheck(inputs);

    const annotations = inputs.github.rest.checks.create.mock.calls[0][0].output.annotations;
    expect(annotations[0].annotation_level).toBe('failure');
    expect(annotations[1].annotation_level).toBe('warning');
    expect(annotations[2].annotation_level).toBe('notice');
    expect(annotations[3].annotation_level).toBe('notice');
  });

  it('builds annotations with correct fields', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([
        {
          filePath: 'config.yaml',
          diagnostics: [makeDiag({ line: 5, character: 3, message: 'Unexpected key', source: 'yaml-schema' })],
        },
      ]),
    );
    const inputs = defaultInputs({ reportPath });

    await createCheck(inputs);

    const annotations = inputs.github.rest.checks.create.mock.calls[0][0].output.annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toEqual({
      path: 'config.yaml',
      start_line: 5,
      end_line: 5,
      start_column: 3,
      end_column: 4,
      annotation_level: 'failure',
      message: 'Unexpected key',
      title: 'yaml-schema',
    });
  });

  it('defaults title to yaml-lint when source is falsy', async () => {
    const diag = makeDiag();
    delete diag.source;
    fs.writeFileSync(reportPath, buildReport([{ filePath: 'test.yaml', diagnostics: [diag] }]));
    const inputs = defaultInputs({ reportPath });

    await createCheck(inputs);

    const annotations = inputs.github.rest.checks.create.mock.calls[0][0].output.annotations;
    expect(annotations[0].title).toBe('yaml-lint');
  });

  it('filters to PR-changed files when onlyPrFiles is true', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([
        { filePath: 'changed.yaml', diagnostics: [makeDiag()] },
        { filePath: 'unchanged.yaml', diagnostics: [makeDiag()] },
      ]),
    );
    const github = mockGitHub();
    github.paginate.mockResolvedValue([{ filename: 'changed.yaml' }]);
    const inputs = defaultInputs({ reportPath, onlyPrFiles: true, github });

    await createCheck(inputs);

    const annotations = github.rest.checks.create.mock.calls[0][0].output.annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations[0].path).toBe('changed.yaml');
  });

  it('skips PR file filtering when not a pull request event', async () => {
    fs.writeFileSync(
      reportPath,
      buildReport([
        { filePath: 'a.yaml', diagnostics: [makeDiag()] },
        { filePath: 'b.yaml', diagnostics: [makeDiag()] },
      ]),
    );
    const context = mockContext({ payload: {} });
    const inputs = defaultInputs({ reportPath, onlyPrFiles: true, context });

    await createCheck(inputs);

    const annotations = inputs.github.rest.checks.create.mock.calls[0][0].output.annotations;
    expect(annotations).toHaveLength(2);
  });

  it('uses context.sha when there is no pull request', async () => {
    fs.writeFileSync(reportPath, buildReport([]));
    const context = mockContext({ payload: {} });
    const inputs = defaultInputs({ reportPath, context });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: 'abc123' }));
  });

  it('batches annotations in groups of 50', async () => {
    const diagnostics = Array.from({ length: 75 }, (_, i) => makeDiag({ message: `error ${i}` }));
    fs.writeFileSync(reportPath, buildReport([{ filePath: 'big.yaml', diagnostics }]));
    const inputs = defaultInputs({ reportPath });

    await createCheck(inputs);

    expect(inputs.github.rest.checks.create).toHaveBeenCalledTimes(1);
    const firstBatch = inputs.github.rest.checks.create.mock.calls[0][0].output.annotations;
    expect(firstBatch).toHaveLength(50);

    expect(inputs.github.rest.checks.update).toHaveBeenCalledTimes(1);
    const secondBatch = inputs.github.rest.checks.update.mock.calls[0][0].output.annotations;
    expect(secondBatch).toHaveLength(25);
  });

  it('writes markdown step summary when stepSummary is true', async () => {
    const summaryFile = path.join(tmpDir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    fs.writeFileSync(
      reportPath,
      buildReport([{ filePath: 'test.yaml', diagnostics: [makeDiag({ message: 'bad value' })] }]),
    );
    const inputs = defaultInputs({ reportPath, stepSummary: true });

    await createCheck(inputs);

    const content = fs.readFileSync(summaryFile, 'utf-8');
    expect(content).toContain('YAML Lint Results');
    expect(content).toContain('1 error(s) and 0 warning(s) found');
    expect(content).toContain('bad value');
  });

  it('does not write step summary when stepSummary is false', async () => {
    const summaryFile = path.join(tmpDir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    fs.writeFileSync(reportPath, buildReport([]));
    const inputs = defaultInputs({ reportPath, stepSummary: false });

    await createCheck(inputs);

    expect(fs.existsSync(summaryFile)).toBe(false);
  });

  it('includes PR context in summary text when filtering by PR files', async () => {
    fs.writeFileSync(reportPath, buildReport([{ filePath: 'a.yaml', diagnostics: [] }]));
    const github = mockGitHub();
    github.paginate.mockResolvedValue([{ filename: 'a.yaml' }]);
    const inputs = defaultInputs({ reportPath, onlyPrFiles: true, github });

    await createCheck(inputs);

    const summary = github.rest.checks.create.mock.calls[0][0].output.summary;
    expect(summary).toContain('in pull request changed files');
  });
});
