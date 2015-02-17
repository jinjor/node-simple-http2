var fs = require('fs');
var express = require('express');
var compress = require('compression');
var autopp = require('./index.js');

///
var app = express();
// app.use(compress({
//   threshold : 0
// }));
app.use(express.static(__dirname + '/public'));
app.listen(3000);
///

var tlsOptions = {
  key: fs.readFileSync('ssl/key.pem'),
  cert: fs.readFileSync('ssl/cert.pem')
};

autopp(tlsOptions, 8443, 3000);