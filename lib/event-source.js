/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');

function determineEventSource(opts, cb) {
    var vmadmEventsOpts;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.ok(['object', 'function']
        .indexOf(typeof (opts.vmadm)) !== -1, 'opts.vmadm');
    assert.func(cb, 'cb');

    /*
     * Figure out the best event source for the system.  Basically, this checks
     * to see if vminfod is supported by looking for `vmadm events` support.
     */
    vmadmEventsOpts = {
        log: opts.log,
        name: 'VM Agent determineEventSource'
    };

    var vs = opts.vmadm.events(vmadmEventsOpts,
        function vmadmEventsHandler() {
            /*
             * We don't care about any events seen here - we are only
             * starting this event stream to see if it is supported on the
             * current platform to best determine the event source to use for
             * all events.
             */
        }, function vmadmEventsReady(err, obj) {
            if (typeof (vs) !== 'undefined') {
                vs.removeAllListeners('error');
            }

            if (err) {
                // vmadm events is not supported, use default eventSource.
                cb(null, 'default');
                return;
            }

            /*
             * vmadm events is supported! stop this stream and use the
             * `vmadm-events` eventSource.
             */
            obj.stop();
            cb(null, 'vmadm-events');
        });
    if (typeof (vs) !== 'undefined') {
        vs.once('error', function (err) {
            cb(err);
        });
    }
}

module.exports = determineEventSource;
