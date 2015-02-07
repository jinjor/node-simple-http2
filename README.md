node-simple-http2
=================

Simple implementation of HTTP/2 server by Node.js

- logging frame info for learning HTTP/2
- working with some browsers
- readable for beginner (no streams & no objects)

### Clone
```
$ git clone --recursive https://github.com/jinjor/node-simple-http2.git
```

### Sample
```
$ cd node-simple-http2/sample
$ node server
```

### Browse

#### Chrome
(2015/02/07)

1. open Chrome
2. visit `chrome://flags/#enable-spdy4`
3. enable SPDY4 and restart Chrome
4. visit `https://localhost:8443`

#### Firefox Nightly
(2014/12/25)

1. open [Firefox Nightly](https://nightly.mozilla.org/)
2. visit `about:config`
3. set `network.http.spdy.enabled.http2draft` to `true`
3. set `network.http.spdy.enforce-tls-profile` to `false`
4. visit `https://localhost:8443`
5. setting this server as trusted one

