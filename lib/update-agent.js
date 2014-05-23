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
        var message = self.stash[uuid];

        // If there was an error sending this update then we need to add it to
        // the retry/backoff cycle
        self.sendUpdate(uuid, message, function (err, req, res, obj) {
            if (err) {
                setTimeout(self.retryUpdate.bind(self, uuid), self.retryDelay);
                return callback(err);
            }

            // Remove from stash
            delete self.stash[uuid];
            callback();
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
        self.sendUpdate(uuid, self.stash[uuid], cb);
    }

    var retry = backoff.call(update, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;

        if (err) {
            log.error('Could not send update after %d attempts', attempts);
            return;
        }

        // Remove from stash when retry has finished
        delete self.stash[uuid];

        log.info('Update %s successfully sent after %d attempts',
            uuid, attempts);
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

    var opts = { path: message.path, query: message.query || {} };
    this.client[message.method].call(
        this.client,
        opts,
        message.payload,
        callback
    );
};


/*
 * Queues an update message to be sent.
 */
UpdateAgent.prototype.queueUpdate = function (uuid, message) {
    var self = this;

    this.log.debug({
        length: this.queue.length(),
        running: this.queue.running()
    },'Pushing %s to the queue', uuid);

    function onUpdateCompleted(err) {
        self.log.debug('UpdateAgent queue task for %s completed', uuid);
    }

    // Only add to queue when there is no item in the stash. This means that
    // stash has stuff when queue is being processed or item is in a retry-
    // backoff cycle
    var exists = (this.stash[uuid] !== undefined);

    // Update stash before pusing to queue
    this.stash[uuid] = message;

    if (!exists) {
        this.queue.push(uuid, onUpdateCompleted);
    }
};


module.exports = UpdateAgent;
