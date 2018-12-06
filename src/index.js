'use strict'

/**
 * index.js
 *
 * a request API compatible with window.fetch
 *
 * All spec algorithm step numbers are based on https://fetch.spec.whatwg.org/commit-snapshots/ae716822cb3a61843226cd090eefc6589446c1d2/.
 */

const Url = require('url')
const http = require('http')
const https = require('https')
const zlib = require('zlib')
const Stream = require('stream')

const Body = require('./body.js')
const writeToStream = Body.writeToStream
const getTotalBytes = Body.getTotalBytes
const Response = require('./response')
const Headers = require('./headers')
const createHeadersLenient = Headers.createHeadersLenient
const Request = require('./request')
const getNodeRequestOptions = Request.getNodeRequestOptions
const FetchError = require('./fetch-error')
const AbortError = require('./abort-error')

// fix an issue where "PassThrough", "resolve" aren't a named export for node <10
const PassThrough = Stream.PassThrough
const resolveUrl = Url.resolve
const parseUrl = Url.parse

/**
 * Fetch function
 *
 * @param   Mixed    url   Absolute url or Request instance
 * @param   Object   opts  Fetch options
 * @return  Promise
 */
exports = module.exports = fetch
function fetch (url, opts) {
  // allow custom promise
  if (!fetch.Promise) {
    throw new Error('native promise missing, set fetch.Promise to your favorite alternative')
  }

  Body.Promise = fetch.Promise

  // wrap http.request into fetch
  return new fetch.Promise((resolve, reject) => {
    // build request object
    const request = new Request(url, opts)
    const options = getNodeRequestOptions(request)

    const send = (options.protocol === 'https:' ? https : http).request
    const signal = request.signal
    let response = null

    const abort = () => {
      let error = new AbortError('The user aborted a request.')
      reject(error)
      if (request.body && request.body instanceof Stream.Readable) {
        request.body.destroy(error)
      }
      if (!response || !response.body) return
      response.body.emit('error', error)
    }

    if (signal && signal.aborted) {
      abort()
      return
    }

    const abortAndFinalize = () => {
      abort()
      finalize()
    }

    // send request
    const req = send(options)
    let reqTimeout

    if (signal) {
      signal.addEventListener('abort', abortAndFinalize)
    }

    function finalize () {
      req.abort()
      if (signal) signal.removeEventListener('abort', abortAndFinalize)
      clearTimeout(reqTimeout)
    }

    if (request.timeout) {
      req.once('socket', socket => {
        reqTimeout = setTimeout(() => {
          reject(new FetchError(`network timeout at: ${request.url}`, 'request-timeout'))
          finalize()
        }, request.timeout)
      })
    }

    req.on('error', err => {
      reject(new FetchError(`request to ${request.url} failed, reason: ${err.message}`, 'system', err))
      finalize()
    })

    req.on('response', res => {
      clearTimeout(reqTimeout)

      const headers = createHeadersLenient(res.headers)

      // HTTP fetch step 5
      if (fetch.isRedirect(res.statusCode)) {
        // HTTP fetch step 5.2
        const location = headers.get('Location')

        // HTTP fetch step 5.3
        const locationURL = location == null ? null : resolveUrl(request.url, location)

        // Remove authorization if changing hostnames (but not if just
        // changing ports or protocols).  This matches the behavior of request:
        // https://github.com/request/request/blob/b12a6245/lib/redirect.js#L134-L138
        if (locationURL && parseUrl(request.url).hostname !== parseUrl(locationURL).hostname) {
          request.headers.delete('authorization')
        }

        // HTTP fetch step 5.5
        switch (request.redirect) {
          case 'error':
            reject(new FetchError(`redirect mode is set to error: ${request.url}`, 'no-redirect'))
            finalize()
            return
          case 'manual':
            // node-fetch-specific step: make manual redirect a bit easier to use by setting the Location header value to the resolved URL.
            if (locationURL !== null) {
              // handle corrupted header
              try {
                headers.set('Location', locationURL)
              } catch (err) {
                // istanbul ignore next: nodejs server prevent invalid response headers, we can't test this through normal request
                reject(err)
              }
            }
            break
          case 'follow':
            // HTTP-redirect fetch step 2
            if (locationURL === null) {
              break
            }

            // HTTP-redirect fetch step 5
            if (request.counter >= request.follow) {
              reject(new FetchError(`maximum redirect reached at: ${request.url}`, 'max-redirect'))
              finalize()
              return
            }

            // HTTP-redirect fetch step 6 (counter increment)
            // Create a new Request object.
            const requestOpts = {
              headers: new Headers(request.headers),
              follow: request.follow,
              counter: request.counter + 1,
              agent: request.agent,
              compress: request.compress,
              method: request.method,
              body: request.body,
              signal: request.signal
            }

            // HTTP-redirect fetch step 9
            if (res.statusCode !== 303 && request.body && getTotalBytes(request) === null) {
              reject(new FetchError('Cannot follow redirect with body being a readable stream', 'unsupported-redirect'))
              finalize()
              return
            }

            // HTTP-redirect fetch step 11
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && request.method === 'POST')) {
              requestOpts.method = 'GET'
              requestOpts.body = undefined
              requestOpts.headers.delete('content-length')
            }

            // HTTP-redirect fetch step 15
            resolve(fetch(new Request(locationURL, requestOpts)))
            finalize()
            return
        }
      }

      // prepare response
      res.once('end', () => {
        if (signal) signal.removeEventListener('abort', abortAndFinalize)
      })
      let body = res.pipe(new PassThrough())

      const responseOptions = {
        url: request.url,
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: headers,
        size: request.size,
        timeout: request.timeout
      }

      // HTTP-network fetch step 12.1.1.3
      const codings = headers.get('Content-Encoding')

      // HTTP-network fetch step 12.1.1.4: handle content codings

      // in following scenarios we ignore compression support
      // 1. compression support is disabled
      // 2. HEAD request
      // 3. no Content-Encoding header
      // 4. no content response (204)
      // 5. content not modified response (304)
      if (!request.compress || request.method === 'HEAD' || codings === null || res.statusCode === 204 || res.statusCode === 304) {
        response = new Response(body, responseOptions)
        resolve(response)
        return
      }

      // For Node v6+
      // Be less strict when decoding compressed responses, since sometimes
      // servers send slightly invalid responses that are still accepted
      // by common browsers.
      // Always using Z_SYNC_FLUSH is what cURL does.
      const zlibOptions = {
        flush: zlib.Z_SYNC_FLUSH,
        finishFlush: zlib.Z_SYNC_FLUSH
      }

      // for gzip
      if (codings === 'gzip' || codings === 'x-gzip') {
        body = body.pipe(zlib.createGunzip(zlibOptions))
        response = new Response(body, responseOptions)
        resolve(response)
        return
      }

      // for deflate
      if (codings === 'deflate' || codings === 'x-deflate') {
        // handle the infamous raw deflate response from old servers
        // a hack for old IIS and Apache servers
        const raw = res.pipe(new PassThrough())
        raw.once('data', chunk => {
          // see http://stackoverflow.com/questions/37519828
          if ((chunk[0] & 0x0F) === 0x08) {
            body = body.pipe(zlib.createInflate())
          } else {
            body = body.pipe(zlib.createInflateRaw())
          }
          response = new Response(body, responseOptions)
          resolve(response)
        })
        return
      }

      // otherwise, use response as-is
      response = new Response(body, responseOptions)
      resolve(response)
    })

    writeToStream(req, request)
  })
};

/**
 * Redirect code matching
 *
 * @param   Number   code  Status code
 * @return  Boolean
 */
fetch.isRedirect = code => code === 301 || code === 302 || code === 303 || code === 307 || code === 308

// expose Promise
fetch.Promise = global.Promise
exports.Headers = Headers
exports.Request = Request
exports.Response = Response
exports.FetchError = FetchError
