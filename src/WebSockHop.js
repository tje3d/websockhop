import { isFunction, isObject, nextUpdate } from "./utils";
import { isWebSocketUnavailable, isInvalidSafari, isMobile } from "./browserDetection";

import Events from "./Events";
import ErrorEnumValue from "./ErrorEnumValue";
import { StringFormatter, JsonFormatter, MessageFormatterBase } from "./formatters";

function defaultCreateSocket(url, protocols) {
    if (!WebSockHop.isAvailable()) {
        throw "WebSockHop cannot be instantiated because one or more validity checks failed.";
    }
    return protocols != null ? new WebSocket(url, protocols) : new WebSocket(url);
}

function extractProtocolsFromOptions({protocol, protocols} = {}) {
    if (Array.isArray(protocols)) {
        return protocols;
    }

    if (typeof protocols === "string" || protocols instanceof String) {
        return [protocols];
    }

    if (typeof protocol === "string" || protocol instanceof String) {
        return [protocol];
    }

    return null;
}

class WebSockHop {
    constructor(url, opts) {
        const protocols = extractProtocolsFromOptions(opts);

        const combinedOptions = Object.assign({}, opts,
            protocols != null ? { protocols } : null
        );

        this._opts = combinedOptions;

        this.socket = null;
        this._url = url;
        this._events = new Events(this);
        this._timer = null;
        this._tries = 0;
        this._aborted = false;
        this._closing = false;
        this.formatter = null;

        this.connectionTimeoutMsecs = 10000; // 10 seconds default connection timeout

        this.defaultRequestTimeoutMsecs = null; // Unless specified, request() calls use this value for timeout
        this.defaultDisconnectOnRequestTimeout = false; // If specified, request "timeout" events will handle as though socket was dropped

        this.protocol = null; // This will eventually hold the protocol that we successfully connected with

        this._attemptConnect();
    }
    _attemptConnect() {
        if (!this._timer) {
            let delay = 0;
            if (this._tries > 0) {
                const timeCap = 1 << Math.min(6, (this._tries - 1));
                delay = timeCap * 1000 + Math.floor(Math.random() * 1000);
                WebSockHop.log("info", `Trying again in ${delay}ms`);
            }
            this._tries = this._tries + 1;

            this._timer = setTimeout(async () => {
                this._timer = null;
                await this._start();
            }, delay);
        }
    }

    _abortConnect() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._aborted = true;
    }

    async _raiseEvent(event, ...args) {
        WebSockHop.log("info", `${event} event start`);
        await this._events.trigger(event, ...args);
        WebSockHop.log("info", `${event} event end`);
    }

    async _start() {
        if (this.formatter == null) {
            WebSockHop.log("info", "No message formatter had been specified, creating a StringFormatter instance as formatter.");
            this.formatter = new StringFormatter();
        }
        await this._raiseEvent("opening");
        if (!this._aborted) {
            const { createSocket = defaultCreateSocket, protocols } = this._opts;
            this.socket = createSocket(this._url, protocols);
            let connectionTimeout = null;
            if (this.connectionTimeoutMsecs) {
                connectionTimeout = setTimeout(() => {
                    WebSockHop.log("warn", "Connection timeout exceeded.");
                    this._raiseErrorEvent(false);
                }, this.connectionTimeoutMsecs);
                WebSockHop.log("info", `Setting connection timeout (${this.connectionTimeoutMsecs} msecs).`);
            }
            const clearConnectionTimeout = () => {
                if (connectionTimeout != null) {
                    WebSockHop.log("info", "Clearing connection timeout.");
                    clearTimeout(connectionTimeout);
                    connectionTimeout = null;
                }
            };
            this.socket.onopen = async () => {
                WebSockHop.log("info", "WebSocket::onopen");
                clearConnectionTimeout();
                this.protocol = this.socket.protocol;
                this._tries = 0;
                await this._raiseEvent("opened");
            };
            this.socket.onclose = ({wasClean, code}) => {
                WebSockHop.log("info", `WebSocket::onclose { wasClean: ${wasClean ? "true" : "false"}, code: ${code} }`);
                clearConnectionTimeout();
                const closing = this._closing;

                if (wasClean) {
                    nextUpdate(async () => {
                        await this._raiseEvent("closed");
                        this.socket = null;
                    });
                } else {
                    nextUpdate(() => {
                        this._raiseErrorEvent(closing);
                    });
                }
            };
            this.socket.onmessage = ({data}) => {
                nextUpdate(() => {
                    WebSockHop.log("info", `WebSocket::onmessage { data: ${data} }`);
                    this._dispatchMessage(data);
                });
            };
        }
    }
    
    async _raiseErrorEvent(isClosing) {
        const willRetry = !isClosing;
        await this._raiseEvent("error", willRetry);
        this._clearSocket();
        if (this.formatter != null) {
            const pendingRequestIds = this.formatter.getPendingHandlerIds();
            if (Array.isArray(pendingRequestIds)) {
                for (const requestId of pendingRequestIds) {
                    await this._dispatchErrorMessage(requestId, {type: ErrorEnumValue.Disconnect});
                }
            }
        }
        if (willRetry) {
            this._attemptConnect();
        }
    }
    // Clear the current this.socket and all state dependent on it.
    _clearSocket() {
        this.socket.onclose = () => WebSockHop.log("info", "closed old socket that had been cleared()");
        this.socket.onmessage = null;
        this.socket.onerror = (error) => WebSockHop.log("info", "error in old socket that had been cleared()", error);;
        this.socket.close();
        this.protocol = null;
        this.socket = null;
    }
    send(obj) {
        if (this.socket) {
            const message = this.formatter.toMessage(obj);
            this.socket.send(message);
        }
    }
    close() {
        if (this.socket) {
            this._closing = true;
            this.socket.close();
        } else {
            this._abortConnect();
            nextUpdate(() => {
                this._raiseErrorEvent(true);
            });
        }
    }
    abort() {
        if (this.socket) {
            WebSockHop.log("warn", "abort() called on live socket, performing forceful shutdown.  Did you mean to call close() ?");
            this.socket.onclose = null;
            this.socket.onmessage = null;
            this.socket.onerror = null;
            this.socket.close();
            this.socket = null;
            this.protocol = null;
        }
        this._abortConnect();
    }
    on(type, handler) {
        this._events.on(type, handler);
    }
    off(type, ...args) {
        this._events.off(type, ...args);
    }
    request(obj, callback, errorCallback, timeoutMsecs, disconnectOnTimeout) {
        return new Promise((resolve, reject) => {
            const request = {
                obj,
                requestTimeoutTimer: null,
                requestTimeoutMsecs: typeof timeoutMsecs !== 'undefined' ? timeoutMsecs : this.defaultRequestTimeoutMsecs,
                requestDisconnectOnTimeout: typeof disconnectOnTimeout !== 'undefined' ? disconnectOnTimeout : this.defaultDisconnectOnRequestTimeout,
                clearTimeout() {
                    if (this.requestTimeoutTimer != null) {
                        clearTimeout(this.requestTimeoutTimer);
                        this.requestTimeoutTimer = null;
                    }
                }
            };

            this.formatter.trackRequest(obj, {
                callback(o) {
                    request.clearTimeout();
                    if (callback != null) {
                        callback(o);
                    }
                    resolve(o);
                },
                errorCallback(err) {
                    if (errorCallback != null) {
                        errorCallback(err);
                    }
                    reject(err);
                }
            });

            this.send(obj);

            if (request.requestTimeoutMsecs > 0) {
                this._startRequestTimeout(request, reject);
            }
        });
    }
    _startRequestTimeout(request, reject) {
        const { obj: { id } } = request;
        request.clearTimeout();
        request.requestTimeoutTimer = setTimeout(async () => {
            WebSockHop.log("info", `timeout exceeded [${id}]`);
            await this._dispatchErrorMessage(id, {type: ErrorEnumValue.Timeout});
            if (request.requestDisconnectOnTimeout) {
                await this._raiseErrorEvent(false);
            }
            reject('timeout');
        }, request.requestTimeoutMsecs);
    }

    async _dispatchMessage(message) {
        let isHandled = false;
        const obj     = this.formatter.fromMessage(message);

        if (this.formatter != null) {
            const handler = isObject(obj) ? this.formatter.getHandlerForResponse(obj) : null;

            if (handler != null) {
                await Promise.resolve(handler.callback(obj));
                isHandled = true;
            }
        }

        if (!isHandled) {
            await this._raiseEvent("message", obj);
        }
    }

    async _dispatchErrorMessage(id, error) {
        if (this.formatter != null) {
            const handler = this.formatter.getHandlerForResponse({id});
            if (handler != null) {
                await Promise.resolve(handler.errorCallback(error));
            }
        }
    }
    static isAvailable() {
        if (isWebSocketUnavailable()) {
            return false;
        }

        if (this.disable.oldSafari && isInvalidSafari()) {
            return false;
        }

        if (this.disable.mobile && isMobile()) {
            return false;
        }

        return true;
    }
}
WebSockHop.logger = null;
if (process.env.NODE_ENV === 'development') {
    WebSockHop.logger = (type, ...message) => {
        console.log(`WebSockHop: ${type} -`, ...message);
    };
}

WebSockHop.log = (type, ...message) => {
    if (WebSockHop.logger != null) {
        WebSockHop.logger(type, ...message);
    }
};

WebSockHop.disable = { oldSafari: true, mobile: true };
WebSockHop.ErrorEnumValue = ErrorEnumValue;
WebSockHop.StringFormatter = StringFormatter;
WebSockHop.JsonFormatter = JsonFormatter;
WebSockHop.MessageFormatterBase = MessageFormatterBase;

export default WebSockHop;
