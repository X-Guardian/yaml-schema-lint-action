# yaml-schema-lint GitHub Action

A composite GitHub Action that lints YAML files against JSON schemas using [yaml-schema-lint](https://github.com/X-Guardian/yaml-schema-lint) and creates a **GitHub Check** with inline annotations and a markdown summary

## Usage

```yaml
yaml-schema-lint:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    checks: write
    pull-requests: read
  steps:
    - uses: actions/checkout@v4

    - uses: X-Guardian/yaml-schema-lint-action@v1
      with:
        patterns: "'**/*.yml' '**/*.yaml'"
```

## Inputs

| Input                             | Description                                            | Required | Default                 |
| --------------------------------- | ------------------------------------------------------ | -------- | ----------------------- |
| `patterns`                        | YAML file paths or glob patterns (space-separated)     | Yes      | —                       |
| `ignore`                          | Glob patterns to exclude (space-separated)             | No       | `**/node_modules/**`    |
| `settings-path`                   | Path to a VS Code `settings.json` with `yaml.schemas`  | No       | `.vscode/settings.json` |
| `no-schema-store`                 | Disable fetching schemas from schemastore.org          | No       | `false`                 |
| `version`                         | yaml-schema-lint version to install (ignored when `binary` is set) | No | `1.1.0`     |
| `binary`                          | Path to a local yaml-schema-lint binary (skips npx install) | No | — |
| `node-version`                    | Node.js version to use                                 | No       | `24`                    |
| `check-name`                      | Name shown in the GitHub Checks tab                    | No       | `YAML Schema Lint Report`      |
| `fail-on-error`                   | Fail the check when errors are found                   | No       | `true`                  |
| `fail-on-warning`                 | Fail the check when warnings are found                 | No       | `true`                  |
| `only-pr-files`                   | Only annotate files changed in the pull request        | No       | `true`                  |
| `markdown-report-on-step-summary` | Write a markdown summary to the step summary           | No       | `true`                  |

## Permissions

The job using this action needs the following permissions:

```yaml
permissions:
  contents: read # to checkout the repository
  checks: write # to create the Check Run
  pull-requests: read # to list PR-changed files (when only-pr-files is true)
```

## How it works

1. **Setup Node.js** using `actions/setup-node`
2. **Install and run** `yaml-schema-lint`, producing a JSON report
3. **Create a GitHub Check Run** via the Checks API with:
   - A conclusion of `success` or `failure` based on the `fail-on-error` / `fail-on-warning` inputs
   - Inline annotations on the PR diff for each diagnostic
   - A markdown summary table written to the GitHub Actions step summary
   - Annotations are batched (max 50 per API call) to handle large reports
