module.exports = {
  port: 8081,
  open: true,
  logLevel: 'info', // debug, info, silent
  startPath: '/site/index.html',
  index: 'index.html',
  notify: true,
  files: ['site', 'dist/**/*.js', 'dist/**/*.css'],
  server: {
    baseDir: './',
    directory: false,
    index: 'index.html',
    middleware: function(req, res, next) {
      if (req.url.endsWith('/')) {
        req.url += 'index.html';
      }
      return next();
    },
  }
};
