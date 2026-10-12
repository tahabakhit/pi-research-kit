# Public repository and release setup

The package metadata names the intended repository URL `tahabakhit/pi-research-kit`; the URL and install examples do not mean a repository or npm release already exists.

## First public repository

1. Review all tracked files for credentials, private fixtures, personal paths, and license/provenance issues. Do not include unrelated private repository history.
2. Run `npm ci --ignore-scripts` and `npm run validate`.
3. Review the production file list with `npm run pack:check`.
4. Commit only the standalone project, then create the public repository and push after explicit approval:

   ```sh
   git add .
   git commit -m "Initial Pi Research Kit release"
   gh repo create tahabakhit/pi-research-kit --public --source=. --remote=origin --push
   ```

5. Enable private vulnerability reporting and branch protection; wait for Linux, macOS, and Windows CI before claiming cross-platform support.
6. Test installation using the public Git source in an isolated Pi configuration.

## npm release

1. Verify npm package-name availability and account ownership. A registry 404 does not guarantee the name can be claimed.
2. Update `package.json`, the lockfile, and `CHANGELOG.md`; do not release an already published version.
3. Run `npm run validate` and review `npm publish --dry-run`.
4. Authenticate with npm outside agent sessions, then publish only with explicit approval: `npm publish --access public`.
5. Tag the release and verify `pi install npm:pi-research-kit@<version>` in an isolated configuration.

Publishing, remote creation, pushing, and active Pi configuration changes are separate operator actions; they are not part of local source extraction.
