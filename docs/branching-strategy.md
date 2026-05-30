# Git Branching Strategy

## Branch Structure

```
main
 └── develop
      ├── feature/lambda-pb-to-ghl
      ├── feature/lambda-ghl-webhook
      ├── feature/lambda-ddb-to-pb
      ├── feature/lambda-retry
      ├── feature/cloudformation-template
      └── feature/docs-update

hotfix/
 └── hotfix/fix-ghl-api-timeout
```

---

## Branch Definitions

### `main`
- **Purpose:** Production-ready code only
- **Protected:** Yes — no direct pushes allowed
- **Deploys to:** Production AWS environment
- **Merge via:** Pull Request from `develop` only (or `hotfix/*` for urgent fixes)
- **Rules:**
  - All CI checks must pass before merge
  - At least 1 review required (even if solo — use as a self-review gate)

### `develop`
- **Purpose:** Integration branch — all completed features merge here first
- **Protected:** Yes — no direct pushes
- **Deploys to:** Staging / dev AWS environment (if configured)
- **Merge via:** Pull Request from `feature/*` branches

### `feature/*`
- **Purpose:** Individual Lambda or documentation work
- **Naming convention:** `feature/<short-description>`
- **Examples:**
  - `feature/lambda-pb-to-ghl`
  - `feature/lambda-ghl-webhook`
  - `feature/cloudformation-infra`
  - `feature/docs-hipaa-update`
- **Merge target:** Always → `develop`
- **Lifetime:** Delete after merge

### `hotfix/*`
- **Purpose:** Urgent production fixes that cannot wait for the full develop → main cycle
- **Naming convention:** `hotfix/<short-description>`
- **Examples:**
  - `hotfix/fix-ssm-param-path`
  - `hotfix/ghl-api-timeout-increase`
- **Merge target:** → `main` AND back-merged into `develop`
- **Lifetime:** Delete after merge

---

## Workflow: Normal Feature Development

```bash
# 1. Always start from develop
git checkout develop
git pull origin develop

# 2. Create your feature branch
git checkout -b feature/lambda-pb-to-ghl

# 3. Work, commit often with meaningful messages
git add src/lambda/pb-to-ghl/index.js
git commit -m "feat(lambda-1): add PB patient fetch with configurable limit"

# 4. Push to remote
git push origin feature/lambda-pb-to-ghl

# 5. Open a Pull Request → develop on GitHub
# 6. CI checks run automatically
# 7. Merge when green
```

---

## Workflow: Hotfix

```bash
# 1. Branch from main (not develop)
git checkout main
git pull origin main
git checkout -b hotfix/fix-ghl-contact-dedup

# 2. Fix, commit
git commit -m "fix(lambda-1): correct GHL contact deduplication logic"

# 3. PR → main
# 4. After merge to main, also merge back to develop
git checkout develop
git merge hotfix/fix-ghl-contact-dedup
git push origin develop
```

---

## Commit Message Convention

Format: `type(scope): short description`

| Type | When to Use |
|---|---|
| `feat` | New feature or Lambda function |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change with no behaviour change |
| `chore` | Build, CI, dependencies |
| `test` | Adding or updating tests |

**Examples:**
```
feat(lambda-1): add configurable patient fetch limit via SSM
fix(lambda-2): handle GHL webhook missing contactId gracefully
docs(architecture): add EventBridge schedule table
chore(ci): add Node.js 22 to GitHub Actions matrix
refactor(lambda-3): extract PB API calls to shared utility
```

---

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] No real API keys, ARNs, table names, or client identifiers in the code
- [ ] No PHI in code, comments, or log strings
- [ ] SSM parameter paths use placeholder naming (e.g. `YOUR_SSM_PATH`)
- [ ] CloudWatch log statements use explicit fields only — no raw payload logging
- [ ] Unit tests updated or added for changed logic
- [ ] `docs/` updated if architecture or data mapping changed
- [ ] Commit messages follow the convention above

---

## Protected Branch Rules (configure on GitHub)

For `main`:
- Require pull request before merging
- Require status checks to pass (CI workflow)
- Require at least 1 approving review
- Do not allow force pushes
- Do not allow deletions

For `develop`:
- Require pull request before merging
- Require status checks to pass (CI workflow)
- Do not allow force pushes
