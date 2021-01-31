const fs = require('fs');
const sh = require('shelljs');
const url = require('url');

let repoUrl;
let pkg = JSON.parse(fs.readFileSync('package.json') as any);
if (typeof pkg.repository === 'object') {
  if (!pkg.repository.hasOwnProperty('url')) {
    throw new Error('URL does not exist in repository section');
  }
  repoUrl = pkg.repository.url;
} else {
  repoUrl = pkg.repository;
}

let userName;
let userMail;
if (typeof pkg.author === 'object') {
  userName = pkg.author.name;
  userMail = pkg.author.email;
} else if (typeof pkg.author === 'string' && pkg.author.indexOf('<') > 0 && pkg.author.indexOf('>') > 0) {
  userName = pkg.author.split('<')[0].trim();
  userMail = pkg.author.substring(pkg.author.indexOf('<') + 1, pkg.author.indexOf('>'));
} else {
  throw new Error('Invalid author. For example: {author: "Bendy Zhang <zb@bndy.net>"}');
}

let parsedUrl = url.parse(repoUrl);
let repository = (parsedUrl.host || '') + (parsedUrl.path || '');
let ghToken = process.env.GITHUB_TOKEN;

sh.echo('⚑ gh-pages publishing...');
sh.cd('docs');
sh.touch('.nojekyll');
sh.exec('git init');
sh.exec('git add .');
sh.exec(`git config user.name "${userName}"`);
sh.exec(`git config user.email "${userMail}"`);
sh.exec('git commit -m "docs(docs): update gh-pages"');
sh.exec(`git push --force --quiet "https://${ghToken}@${repository}" master:gh-pages`);
sh.echo(`✔ done at ${new Date().toISOString()}`);
