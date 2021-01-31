axios.get('../README.md').then(function(response) {
  var converter = new showdown.Converter();
  document.getElementById('readme').innerHTML = converter.makeHtml(response.data);
});

axios.get('../CHANGELOG.md').then(function(response) {
  var converter = new showdown.Converter();
  document.getElementById('changelog-body').innerHTML = converter.makeHtml(response.data);
});
