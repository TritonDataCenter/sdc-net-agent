/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_common = require('./common');
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var mod_util = require('util');

// --- Globals

var DIFF_FIELDS = [
    'gateway',
    'mtu',
    'netmask',
    'nic_tag',
    'resolvers',
    'routes',
    'vlan_id'
];

/*
 * EventEmitters emit a warning to stderr when many listeners are added to
 * an event. Since the default is to warn after 10, and every NIC on a network
 * will be listening, we bump the limit here to make it less likely to warn.
 */
var MAX_NIC_LISTENERS = 512;


// --- Exports

/**
 * The NetFSM is responsible for tracking changes related to a single network.
 */
function NetworkFSM(opts) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.object(opts.app, 'opts.app');

    this.uuid = opts.uuid;
    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'network',
        network_uuid: this.uuid
    }, true);

    this.old = null;
    this.cur = null;

    mod_mooremachine.FSM.call(this, 'init');
}
mod_util.inherits(NetworkFSM, mod_mooremachine.FSM);

NetworkFSM.prototype.state_init = function (S) {
    this.setMaxListeners(MAX_NIC_LISTENERS);

    S.immediate(function () {
        S.gotoState('refresh');
    });
};

NetworkFSM.prototype.state_waiting = function (S) {
    S.validTransitions([ 'refresh' ]);

    if (!mod_jsprim.deepEqual(this.old, this.cur)) {
        this.emit('updated', this.cur);
    }

    /*
     * Refresh periodically.
     */
    S.timeout(5 * 60 * 1000, function () {
        S.gotoState('refresh');
    });

    S.on(this, 'refreshAsserted', function () {
        S.gotoState('refresh');
    });
};

NetworkFSM.prototype.state_refresh = function (S) {
    var self = this;

    S.validTransitions([
        'refresh',
        'waiting'
    ]);

    self.old = self.cur;

    function afterGet(err, net) {
        if (err) {
            if (err.statusCode === 404) {
                self.log.error(err, 'Network disappeared from NAPI; stopping');
                S.gotoState('stopped');
                return;
            }

            S.gotoState('refresh');
            return;
        }

        self.cur = net;

        if (mod_common.hasChanged(DIFF_FIELDS, self.cur, self.old)) {
            self.emit('changed');
        }

        S.gotoState('waiting');
    }

    S.on(self, 'stopAsserted', function () {
        S.gotoState('stopped');
    });

    self.log.info('Refreshing network information');
    self.app.napi.getNetwork(self.uuid, S.callback(afterGet));
};

NetworkFSM.prototype.state_stopped = function (S) {
    S.validTransitions([ 'refresh' ]);

    S.on(this, 'refreshAsserted', function () {
        S.gotoState('refresh');
    });
};

NetworkFSM.prototype.refresh = function () {
    this.emit('refreshAsserted');
};

NetworkFSM.prototype.stop = function () {
    this.emit('stopAsserted');
};

module.exports = NetworkFSM;
