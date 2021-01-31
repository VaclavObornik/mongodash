const fs = require('fs');
const sh = require('shelljs');

sh.echo('⚑ gh-pages preparing...');

sh.mkdir('-p', './docs');
sh.cp('README.md', './docs/README.md');
sh.cp('CHANGELOG.md', './docs/CHANGELOG.md');

sh.rm('-rf', './docs/coverage-report');
sh.cp('-R', './reports/coverage/lcov-report', './docs/coverage-report');

sh.rm('-rf', './docs/mutation-report');
sh.cp('-R', './reports/mutation/html-report', './docs/mutation-report');

sh.rm('-rf', './docs/site');
sh.cp('-R', './site', './docs/site');
sh.cd('./docs/site');
sh.ls('*.html').forEach((file: string) => {
  let data = fs.readFileSync(file, 'utf8');
  // remove <!-- dev --> ... <!-- /dev --> lines
  data = data.replace(/<!--\s*dev\s*-->[\s\S]*?<!--\s*\/dev\s*-->/gi, '');
  // uncomment <!-- prod ... -->
  data = data.replace(/<\!--\s*prod\s*([\s\S]*?)-->/gi, '$1');
  fs.writeFileSync(file, data, (werr: any) => {
    if (werr) {
      throw werr;
    }
  });
});
sh.cd('../../');

sh.cd('./docs');
fs.writeFileSync('index.html', '<script>location.href="site";</script>');
sh.cd('../');

sh.echo(`✔ done at ${new Date().toISOString()}`);
