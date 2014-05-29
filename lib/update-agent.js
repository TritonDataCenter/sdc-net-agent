/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * update-agent.js
 */

var async = require('async');
var restify = require('restify');
var backoff = require('backoff');


function UpdateAgent(options) {
    this.options = options;
    this.log = options.log;

    this.concurrency = options.concurrency || 50;
    this.retry = options.retry || { initialDelay: 2000, maxDelay: 64000};
    this.retryDelay = 1000;

    // When items are pushed to the queue, they are stored here so clients
    // can update the payloads of the objects while UpdateAgent is doing
    // retry-backoff cycles for them. Example scenario: corrupt VM data and
    // VMAPI is refusing to update, then VM gets fixed and retry works
    this.stash = {};

    this.client = restify.createJsonClient({ url: options.url });
    this.initializeQueue();
}


/*
 * Initializes the UpdateAgent queue
 */
UpdateAgent.prototype.initializeQueue = function () {
    var self = this;
    var log = this.log;

    var queue = this.queue = async.queue(function (uuid, callback) {
        var message = self.stash[uuid][0];

        // If there was an error sending this update then we need to add it to
        // the retry/backoff cycle
        self.sendUpdate(uuid, message, function (err, req, res, obj) {
            if (err) {
                setTimeout(self.retryUpdate.bind(self, uuid), self.retryDelay);
                return callback(err);
            }

            self.queueNextUpdate(uuid);
            return callback();
        });

    }, this.concurrency);

    queue.drain = function () {
        log.trace('UpdateAgent queue has been drained');
    };

    queue.saturated = function () {
        log.trace('UpdateAgent queue has been saturated');
    };
};


/*
 * Retries an update operation.
 */
UpdateAgent.prototype.retryUpdate = function (uuid) {
    var self = this;
    var log = this.log;
    var retryOpts = this.retry;

    function logAttempt(aLog, host) {
        function _log(number, delay, err) {
            var level;
            if (number === 0) {
                level = 'info';
            } else if (number < 5) {
                level = 'warn';
            } else {
                level = 'error';
            }
            aLog.error(err, 'UpdateAgent retry error');
            aLog[level]({
                ip: host,
                attempt: number,
                delay: delay
            }, 'UpdateAgent retry attempt for %s', uuid);
        }

        return (_log);
    }

    // Always get the latest value from the stash
    function update(cb) {
        self.sendUpdate(uuid, self.stash[uuid][0], cb);
    }

    var retry = backoff.call(update, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;

        if (err) {
            log.error('Could not send update after %d attempts', attempts);
        } else {
            log.info(logVm(uuid, self.stash[uuid][0]),
                'Update %s successfully sent after %d attempts',
                uuid, attempts);
        }

        self.queueNextUpdate(uuid);
    });

    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: retryOpts.initialDelay,
        maxDelay: retryOpts.maxDelay
    }));

    retry.failAfter(retryOpts.retries || Infinity);
    retry.on('backoff', logAttempt(log));

    retry.start();
};


/*
 * Sends an update. Clients that use UpdateAgent must conform to the following
 * object format:
 *
 * {
 *   path: <API endpoint>,
 *   query: <HTTP query params>,
 *   method: <HTTP method>,
 *   payload: <payload>
 * }
 */
UpdateAgent.prototype.sendUpdate = function (uuid, message, callback) {
    if (message.method !== 'post' && message.method !== 'put') {
        process.nextTick(function () {
            callback(new Error('Unsupported update method'));
        });
    }

    this.log.debug(logVm(uuid, message), 'UpdateAgent sending state', uuid);

    var opts = { path: message.path, query: message.query || {} };
    this.client[message.method].call(
        this.client,
        opts,
        message.payload,
        callback);
};


/*
 * Queues an update message to be sent.
 */
UpdateAgent.prototype.queueUpdate = function (uuid, message) {
    var logObj = logVm(uuid, message);
    logObj.length = this.queue.length();
    logObj.running = this.queue.running();
    this.log.debug(logObj, 'Pushing %s to the queue', uuid);

    // Only add to queue when there is no item in the stash. This means that
    // stash has stuff when queue is being processed or item is in a retry-
    // backoff cycle
    if (this.stash[uuid] !== undefined) {
        this.stash[uuid].push(message);
        this.log.info(logVm(uuid, message),
            'UpdateAgent item added to per-item queue %s', uuid);
    } else {
        this.stash[uuid] = [ message ];
        this._queueUpdate(uuid, message);
    }
};


/*
 * Pushes an item directly to the update queue
 */
UpdateAgent.prototype._queueUpdate = function (uuid, message) {
    var log = this.log;

    function onUpdateCompleted(err) {
        if (err) {
            var logErr = logVm(uuid, message);
            logErr.err = err;
            log.error(logErr,
                'UpdateAgent task for %s completed with error', uuid);
        } else {
            log.debug(logVm(uuid, message),
                'UpdateAgent queue task for %s completed', uuid);
        }
    }

    this.queue.push(uuid, onUpdateCompleted);
};


/*
 * See if there are more items in the stash, update the stash and queue a new
 * update task for the next item in the list
 */
UpdateAgent.prototype.queueNextUpdate = function (uuid) {
    if (this.stash[uuid].length > 1) {
        this.stash[uuid].shift();
        this._queueUpdate(uuid, this.stash[uuid][0]);
    } else {
        delete this.stash[uuid];
    }
};


/*
 * Helper method to log what is being processed
 */
function logVm(uuid, message) {
    if (message.payload.vms) {
        return { server_uuid: uuid };
    } else {
        return { uuid: uuid, state: message.payload.state };
    }
}


module.exports = UpdateAgent;
