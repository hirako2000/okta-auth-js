/* eslint-disable @typescript-eslint/no-non-null-assertion */
/*!
 * Copyright (c) 2015-present, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */

/* eslint-disable complexity */
import { isString, clone, isAbsoluteUrl, removeNils } from '../util';
import {
  STATE_TOKEN_KEY_NAME,
  DEFAULT_CACHE_DURATION,
  IOS_MAX_RETRY_COUNT,
} from '../constants';
import {
  OktaAuthHttpInterface,
  RequestOptions,
  FetchOptions,
  RequestData,
  HttpResponse
} from './types';
import { AuthApiError, OAuthError, APIError, WWWAuthError } from '../errors';
import { isBrowser } from '../features';


// For iOS track last date when document became visible
let dateDocumentBecameVisible = 0;
let trackDateDocumentBecameVisible: () => void;
if (isBrowser()) {
  dateDocumentBecameVisible = Date.now();
  trackDateDocumentBecameVisible = () => {
    if (!document.hidden) {
      dateDocumentBecameVisible = Date.now();
    }
  };
  document.addEventListener('visibilitychange', trackDateDocumentBecameVisible);
}

const formatError = (sdk: OktaAuthHttpInterface, error: HttpResponse | Error): AuthApiError | OAuthError => {
  if (error instanceof Error) {
    // fetch() can throw exceptions
    // see https://developer.mozilla.org/en-US/docs/Web/API/fetch#exceptions
    return new AuthApiError({
      errorSummary: error.message,
    });
  }

  let resp: HttpResponse = error;
  let err: AuthApiError | OAuthError | WWWAuthError;
  let serverErr: Record<string, any> = {};
  if (resp.responseText && isString(resp.responseText)) {
    try {
      serverErr = JSON.parse(resp.responseText);
    } catch (e) {
      serverErr = {
        errorSummary: 'Unknown error'
      };
    }
  }

  if (resp.status >= 500) {
    serverErr.errorSummary = 'Unknown error';
  }

  if (sdk.options.transformErrorXHR) {
    resp = sdk.options.transformErrorXHR(clone(resp));
  }

  // 
  const wwwAuthHeader = WWWAuthError.getWWWAuthenticateHeader(resp?.headers) ?? '';

  if (serverErr.error && serverErr.error_description) {
    err = new OAuthError(serverErr.error, serverErr.error_description, resp);
  } else {
    err = new AuthApiError(serverErr as APIError, resp, { wwwAuthHeader });
  }

  if (wwwAuthHeader && resp?.status >= 400 && resp?.status < 500) {
    const wwwAuthErr = WWWAuthError.parseHeader(wwwAuthHeader);
    // check for 403 to avoid breaking change
    if (resp.status === 403 && wwwAuthErr?.error === 'insufficient_authentication_context') {
      // eslint-disable-next-line camelcase
      const { max_age, acr_values } = wwwAuthErr.parameters;
      err = new AuthApiError(
        {
          errorSummary: wwwAuthErr.error,
          errorCauses: [{ errorSummary: wwwAuthErr.errorDescription }]
        },
        resp,
        {
          // eslint-disable-next-line camelcase
          max_age: +max_age,
          // eslint-disable-next-line camelcase
          ...(acr_values && { acr_values })
        }
      );
    }
    else if (wwwAuthErr?.scheme === 'DPoP') {
      err = wwwAuthErr;
    }
    // else {
    //   // WWWAuthError.parseHeader may return null, only overwrite if !null
    //   err = wwwAuthErr ?? err;
    // }
  }

  return err;
};

// eslint-disable-next-line max-statements
export function httpRequest(sdk: OktaAuthHttpInterface, options: RequestOptions): Promise<any> {
  options = options || {};

  if (sdk.options.httpRequestInterceptors) {
    for (const interceptor of sdk.options.httpRequestInterceptors) {
      interceptor(options);
    }
  }

  var url = options.url,
      method = options.method,
      args = options.args,
      saveAuthnState = options.saveAuthnState,
      accessToken = options.accessToken,
      withCredentials = options.withCredentials === true, // default value is false
      storageUtil = sdk.options.storageUtil,
      storage = storageUtil!.storage,
      httpCache = sdk.storageManager.getHttpCache(sdk.options.cookies),
      pollingIntent = options.pollingIntent,
      pollDelay = sdk.options.pollDelay ?? 0;

  if (options.cacheResponse) {
    var cacheContents = httpCache.getStorage();
    var cachedResponse = cacheContents[url as string];
    if (cachedResponse && Date.now()/1000 < cachedResponse.expiresAt) {
      return Promise.resolve(cachedResponse.response);
    }
  }

  var oktaUserAgentHeader = sdk._oktaUserAgent.getHttpHeader();
  var headers: HeadersInit = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...oktaUserAgentHeader
  };
  Object.assign(headers, sdk.options.headers, options.headers);
  headers = removeNils(headers) as HeadersInit;

  if (accessToken && isString(accessToken)) {
    headers['Authorization'] = 'Bearer ' + accessToken;
  }

  var ajaxOptions: FetchOptions = {
    headers,
    data: args || undefined,
    withCredentials
  };

  var err, res, promise;

  if (pollingIntent && isBrowser() && pollDelay > 0) {
    let waitForVisibleAndAwakenDocument: () => Promise<void>;
    let waitForAwakenDocument: () => Promise<void>;
    let recursiveFetch: () => Promise<HttpResponse>;
    let retryCount = 0;

    // Safari on iOS has a bug:
    //  Performing `fetch` right after document became visible can fail with `Load failed` error.
    // Running fetch after short timeout fixes this issue.
    waitForAwakenDocument = () => {
      const timeSinceDocumentIsVisible = Date.now() - dateDocumentBecameVisible;
      if (timeSinceDocumentIsVisible < pollDelay) {
        return new Promise<void>((resolve) => setTimeout(() => {
          if (!document.hidden) {
            resolve();
          } else {
            resolve(waitForVisibleAndAwakenDocument());
          }
        }, pollDelay - timeSinceDocumentIsVisible));
      } else {
        return Promise.resolve();
      }
    };

    // Returns a promise that resolves when document is visible for 500 ms
    waitForVisibleAndAwakenDocument = () => {
      if (document.hidden) {
        let pageVisibilityHandler: () => void;
        return new Promise<void>((resolve) => {
          pageVisibilityHandler = () => {
            if (!document.hidden) {
              document.removeEventListener('visibilitychange', pageVisibilityHandler);
              resolve(waitForAwakenDocument());
            }
          };
          document.addEventListener('visibilitychange', pageVisibilityHandler);
        });
      } else {
        return waitForAwakenDocument();
      }
    };

    // Restarts fetch on 'Load failed' error
    // This error can occur when `fetch` does not respond
    //  (due to CORS error, non-existing host, or network error)
    const retryableFetch = (): Promise<HttpResponse> => {
      return sdk.options.httpRequestClient!(method!, url!, ajaxOptions).catch((err) => {
        const isNetworkError = err?.message === 'Load failed';
        if (isNetworkError && retryCount < IOS_MAX_RETRY_COUNT) {
          retryCount++;
          return recursiveFetch();
        }
        throw err;
      });
    };

    // Final promise to fetch that wraps logic with waiting for visible document
    //  and retrying fetch request on network error
    recursiveFetch = (): Promise<HttpResponse> => {
      return waitForVisibleAndAwakenDocument().then(retryableFetch);
    };

    promise = recursiveFetch();
  } else {
    promise = sdk.options.httpRequestClient!(method!, url!, ajaxOptions);
  }

  return promise
    .then(function(resp) {
      res = resp.responseText;
      if (res && isString(res)) {
        res = JSON.parse(res);
        if (res && typeof res === 'object' && !res.headers) {
          if (Array.isArray(res)) {
            res.forEach(item => {
              item.headers = resp.headers;
            });
          } else {
            res.headers = resp.headers;
          }
        }
      }

      if (saveAuthnState) {
        if (!res.stateToken) {
          storage.delete(STATE_TOKEN_KEY_NAME);
        }
      }

      if (res && res.stateToken && res.expiresAt) {
        storage.set(STATE_TOKEN_KEY_NAME, res.stateToken, res.expiresAt, sdk.options.cookies!);
      }

      if (res && options.cacheResponse) {
        httpCache.updateStorage(url!, {
          expiresAt: Math.floor(Date.now()/1000) + DEFAULT_CACHE_DURATION,
          response: res
        });
      }
      
      return res;
    })
    .catch(function(resp) {
      err = formatError(sdk, resp);

      if (err.errorCode === 'E0000011') {
        storage.delete(STATE_TOKEN_KEY_NAME);
      }

      throw err;
    });
}

export function get(sdk: OktaAuthHttpInterface, url: string, options?: RequestOptions) {
  url = isAbsoluteUrl(url) ? url : sdk.getIssuerOrigin() + url;
  var getOptions = {
    url: url,
    method: 'GET'
  };
  Object.assign(getOptions, options);
  return httpRequest(sdk, getOptions);
}

export function post(sdk: OktaAuthHttpInterface, url: string, args?: RequestData, options?: RequestOptions) {
  url = isAbsoluteUrl(url) ? url : sdk.getIssuerOrigin() + url;
  var postOptions = {
    url: url,
    method: 'POST',
    args: args,
    saveAuthnState: true
  };
  Object.assign(postOptions, options);
  return httpRequest(sdk, postOptions);
}
