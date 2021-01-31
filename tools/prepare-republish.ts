const path = require('path');
const sh = require('shelljs');
const cli = require('@bndynet/cli');

cli.print(cli.styles.info(`
# **** NOTE THAT ****
# This command is just for failed to publish to NPM during running GitHub Action.
# That will rewrite your history commits.
# Please double confirm the commit id you typed and which is in your current branch.
# *******************
`));

cli.questions(['Version(v1.0.0):', 'Commit id for publish:']).then((answers: any[]) => {
  const version = answers[0] || 'v1.0.0';
  const commitId = answers[1];

  cli.log(`Remove your remote tag ${version} ...`);
  sh.exec(`git tag -d ${version}`);
  sh.exec(`git push --delete origin ${version}`);

  cli.log(`Reset your commit and force to push ...`);
  sh.exec(`git reset ${commitId} --hard && git push -f`);
});