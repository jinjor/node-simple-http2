node-simple-http2
=================

Simple implementation of http2 server by Node.js

### Clone
```
$ git clone --recursive https://github.com/jinjor/node-simple-http2.git
```

### Start
```
$ cd node-simple-http2
$ node index
```
PEM pass is `http2`.

### Browse
(2014/12/25)

1. open [Firefox Nightly](https://nightly.mozilla.org/)
2. visit `about:config`
3. set `network.http.spdy.enforce-tls-profile` to `false`
4. visit `https://localhost:8443`
