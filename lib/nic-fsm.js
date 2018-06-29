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

var ANTI_SPOOF_FIELDS = [
    'allow_dhcp_spoofing',
    'allow_ip_spoofing',
    'allow_mac_spoofing',
    'allow_restricted_traffic',
    'allow_unfiltered_promisc'
];

var LOCAL_FIELDS = [
    'belongs_to_type',
    'cn_uuid',
    'owner_uuid',
    'primary',
    'state'
];

var REMOTE_FIELDS = [
    'allow_dhcp_spoofing',
    'allow_ip_spoofing',
    'allow_mac_spoofing',
    'allow_restricted_traffic',
    'allow_unfiltered_promisc',
    'gateway',
    'ip',
    'model',
    'mtu',
    'netmask',
    'network_uuid',
    'nic_tag',
    'vlan_id'
];

var VM_FIELDS = [
    'resolvers',
    'routes'
];


// --- Internal helpers

function boolFromVal(value) {
    if (value === 'false' || value === '0') {
        return false;
    } else if (value === undefined || value === null) {
        return false;
    } else if (value === 'true' || value === '1') {
        return true;
    } else {
        // else should be boolean
        return value;
    }
}

function getDifferences(fields, cur, old) {
    var update = {};

    fields.forEach(function (field) {
        if (ANTI_SPOOF_FIELDS.indexOf(field) !== -1) {
            if (boolFromVal(cur[field]) !== boolFromVal(old[field])) {
                update[field] = boolFromVal(cur[field]);
            }
            return;
        }

        if (cur[field] !== old[field]) {
            update[field] = cur[field];
        }
    });

    /*
     * We only ever update "primary" to true. Updating it to "false" isn't
     * necessary since setting a new primary NIC removes the flag from the
     * old one.
     */
    if (update.primary !== true) {
        delete update.primary;
    }

    return update;
}


// --- Exports

/**
 * The NicFSM is responsible for tracking changes related to a single NIC,
 * located either on a VM or the CN's global zone.
 *
 * The state machine looks like the following (note that retries aren't
 * depicted here, but are loops back into the same state usually).
 *
 *                       +---------+
 *                       | create  | -------------------------+
 *                       +---------+                          |
 *                 404 on 1st ^                               |
 *                    refresh |    setLocal()                 |
 *       +------+        +---------+ -----> +--------+        |
 *       | init | -----> | refresh |        | update |        |
 *       +------+        +---------+   +--- +--------+        |
 *                        |   ^        |         |            |
 *           NAPI 404 for |   |        |         |            |
 *           existing NIC |   |        |         |            |
 *       +---------+      |   |        |         |            |
 *       | remove  | <----+   |        |         |            |
 *       +---------+          |        |         |            |
 *            |               |        |         |            |
 *            v               |        |         v            |
 *       +---------+     +---------+   |    +--------------+  |
 *       | stopped |     | waiting | <-+--- | update.local | -+
 *       +---------+     +---------+   |    +--------------+  |
 *            ^                        |                      |
 *            |          +---------+   +--- +--------------+  |
 *            +----<---- | release |        | update.napi  | -+
 *            |          +---------+        +--------------+  |
 *            |               ^                  |            |
 *            |               |     NAPI 404     |            |
 *            +----<--------- | -----------------+            |
 *                            |        releaseFrom()          |
 *                            +-------------------------------+
 */
function NicFSM(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.mac, 'opts.mac');
    assert.object(opts.app, 'opts.app');

    this.mac = opts.mac;
    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'nic',
        mac: this.mac
    }, true);

    this.pending = {
        refresh: false,
        update: false
    };
    this.released = null;

    this.needVmUpdate = false;

    this.local = null;
    this.remote = null;

    /*
     * We track the "Etag" header so that we can be careful
     * about our DELETEs.
     */
    this.etag = undefined;

    this.network = null;

    mod_mooremachine.FSM.call(this, 'init');
}
mod_util.inherits(NicFSM, mod_mooremachine.FSM);

NicFSM.prototype.state_init = function (S) {
    S.immediate(function () {
        S.gotoState('refresh');
    });
};

/**
 * Wait for external events to force us to recompare.
 */
NicFSM.prototype.state_waiting = function (S) {
    S.on(this, 'setAsserted', function () {
        S.gotoState('update');
    });

    S.on(this, 'refreshAsserted', function () {
        S.gotoState('refresh');
    });

    /*
     * Refresh periodically.
     *
     * Since most of our important attributes live on the network object, we
     * wait an hour to check here, and rely on the network information refresh
     * to let us know when something important changes. If NIC-specific
     * properties like spoofing parameters change, we'll eventually fix them.
     */
    S.timeout(60 * 60 * 1000, function () {
        S.gotoState('refresh');
    });

    S.on(this, 'releaseAsserted', function () {
        S.gotoState('release');
    });

    if (this.network !== null) {
        S.on(this.network, 'changed', function () {
            S.gotoState('refresh');
        });
    }
};

NicFSM.prototype.state_refresh = function (S) {
    var self = this;

    S.validTransitions([
        'create',
        'refresh',
        'remove',
        'update'
    ]);

    S.on(self, 'refreshAsserted', function () {
        S.gotoState('refresh');
    });

    S.on(self, 'releaseAsserted', function () {
        S.gotoState('release');
    });

    function afterGet(err, nic, _, res) {
        if (err) {
            if (err.statusCode === 404) {
                if (self.remote === null) {
                    S.gotoState('create');
                } else {
                    S.gotoState('remove');
                }
                return;
            }

            self.log.warn(err,
                'Failed to refresh NIC information; ' +
                'retrying in 5 seconds');
            S.timeout(5000, function () {
                S.gotoState('refresh');
            });
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        self.log.info('Refreshed NIC information');

        S.gotoState('update');
    }

    self.log.info('Refreshing NIC information');

    self.app.napi.getNic(self.mac, S.callback(afterGet));
};

NicFSM.prototype.state_create = function (S) {
    var self = this;
    var deleted = false;

    S.validTransitions([
        'refresh',
        'release',
        'waiting'
    ]);

    if (self.local === null) {
        S.gotoState('waiting');
        return;
    }

    S.on(this, 'releaseAsserted', function () {
        /*
         * We wait to move to the "release" state to ensure that our
         * POST always comes entirely before the DELETE.
         */
        deleted = true;
    });

    function afterCreate(err, nic, _, res) {
        if (deleted) {
            S.gotoState('release');
            return;
        }

        if (err) {
            self.log.warn(err,
                'Failed to create NIC in NAPI; ' +
                'scheduling state refresh');
            S.timeout(5000, function () {
                S.gotoState('refresh');
            });
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        S.gotoState('waiting');
    }

    self.log.info({ nic: self.local }, 'Syncing local NIC to NAPI');

    self.app.napi.createNic(self.mac, self.local, S.callback(afterCreate));
};

NicFSM.prototype.state_update = function (S) {
    S.validTransitions([
        'refresh',
        'remove',
        'update.local',
        'waiting'
    ]);

    /*
     * We haven't seen a local NIC yet. Go to state "waiting" until
     * we're assigned one.
     */
    if (this.local === null) {
        this.log.debug('No local NIC information yet');
        S.gotoState('waiting');
        return;
    }

    /*
     * If the belongs_to_uuid has changed, then we need to move the NIC.
     */
    if (this.local.belongs_to_uuid !== this.remote.belongs_to_uuid) {
        S.gotoState('remove');
        return;
    }

    S.on(this, 'refreshAsserted', function () {
        S.gotoState('refresh');
    });

    S.gotoState('update.local');
};

NicFSM.prototype.state_update.local = function (S) {
    var self = this;

    S.validTransitions([
        'release',
        'update.local',
        'update.napi',
        'waiting'
    ]);

    var locupdate = getDifferences(REMOTE_FIELDS, self.remote, self.local);

    var needNicUpdate = !mod_jsprim.isEmpty(locupdate);
    var needVmUpdate = this.needVmUpdate;

    this.needVmUpdate = false;

    if (!needNicUpdate && !needVmUpdate) {
        self.log.trace('No local changes needed');
        S.gotoState('update.napi');
        return;
    }

    S.on(this, 'releaseAsserted', function () {
        S.gotoState('release');
    });

    function afterUpdate(err) {
        if (err) {
            self.log.error(err, 'Failed to update NIC on %s %s',
                self.local.belongs_to_type, self.local.belongs_to_uuid);
            S.gotoState('update.local');
            return;
        }

        S.gotoState('update.napi');
    }

    locupdate.mac = self.mac;

    var owner;
    switch (self.local.belongs_to_type) {
    case 'zone':
        if (!mod_jsprim.hasKey(self.app.insts, self.local.belongs_to_uuid)) {
            self.log.warn('Cannot update NIC %s for nonexistent VM %s',
                self.local.belongs_to_uuid);
            S.gotoState('waiting');
            return;
        }

        owner = self.app.insts[self.local.belongs_to_uuid];
        break;
    case 'server':
        if (self.local.belongs_to_uuid !== self.app.cn_uuid) {
            self.log.warn('Server NIC is for CN %s, not the local CN (%s)',
                self.local.belongs_to_uuid, self.app.cn_uuid);
            S.gotoState('waiting');
            return;
        }

        owner = self.app.server;
        break;
    case 'other':
        self.log.warn('Ignoring NIC with belongs_to_type=other');
        S.gotoState('waiting');
        return;
    default:
        self.log.warn('Ignoring unknown "belongs_to_type" value: %j',
            self.local.belongs_to_type);
        S.gotoState('waiting');
        return;
    }

    if (needNicUpdate) {
        owner.updateNIC(self.mac, locupdate, S.callback(afterUpdate));
    } else {
        owner.refresh();
        S.gotoState('update.napi');
    }
};

NicFSM.prototype.state_update.napi = function (S) {
    var self = this;
    var updated = false;

    S.validTransitions([
        'release',
        'update',
        'update.napi',
        'stopped',
        'waiting'
    ]);

    var remupdate = getDifferences(LOCAL_FIELDS, self.local, self.remote);
    if (mod_jsprim.isEmpty(remupdate)) {
        self.log.trace('No remote changes needed');
        S.gotoState('waiting');
        return;
    }

    S.on(this, 'setAsserted', function () {
        /*
         * We wait to move to the "update" state again to ensure that our
         * PUTs are always correctly ordered.
         */
        updated = true;
    });

    S.on(this, 'releaseAsserted', function () {
        /*
         * It's okay for our DELETE to race with the PUT:
         *
         * - If the PUT wins, the DELETE will fail due to the "If-Match" header,
         *   and will retry after refreshing.
         * - If the DELETE wins, the PUT will fail, and we ignore the response.
         */
        S.gotoState('release');
    });

    function afterPut(err, nic, _, res) {
        if (err) {
            if (err.statusCode === 404) {
                self.log.warn('NIC no longer in NAPI, stopping');
                S.gotoState('stopped');
                return;
            }

            self.log.error(err, 'Failed to update NIC in NAPI');
            S.gotoState('update.napi');
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        if (updated) {
            S.gotoState('update');
        } else {
            S.gotoState('waiting');
        }
    }

    remupdate.check_owner = false;

    self.log.info({ payload: remupdate }, 'Updating NIC in NAPI');

    self.app.napi.updateNic(self.mac, remupdate, S.callback(afterPut));
};

NicFSM.prototype.state_remove = function (S) {
    var self = this;

    S.validTransitions([
        'remove',
        'stopped'
    ]);

    if (!mod_jsprim.hasKey(self.app.insts, self.local.belongs_to_uuid)) {
        S.gotoState('stopped');
        return;
    }

    function afterRemove(err) {
        if (err) {
            self.log.error(err, 'Failed to update NIC on VM %s',
                self.local.belongs_to_uuid);
            S.timeout(5000, function () {
                S.gotoState('remove');
            });
            return;
        }

        S.gotoState('stopped');
    }

    self.app.insts[self.local.belongs_to_uuid].removeNIC(
        self.mac, S.callback(afterRemove));
};

NicFSM.prototype.state_release = function (S) {
    S.validTransitions([
        'release.delete',
        'release.refresh',
        'stopped'
    ]);

    S.gotoState('release.delete');
};

NicFSM.prototype.state_release.delete = function (S) {
    var self = this;

    if (self.remote === null) {
        S.gotoState('release.refresh');
        return;
    }

    if (self.released !== self.remote.belongs_to_uuid) {
        self.log.info('Skipping NIC deletion, ' +
            'since upstream belongs_to_uuid has changed');
        S.gotoState('stopped');
        return;
    }

    if (self.remote.state !== 'running' && self.remote.state !== 'stopped') {
        self.log.info('Skipping NIC deletion, ' +
            'since upstream state isn\'t running or stopped');
        S.gotoState('stopped');
        return;
    }

    if (typeof (self.etag) !== 'string') {
        self.log.warn('No "Etag" set, skipping deletion');
        S.gotoState('stopped');
        return;
    }

    function afterDelete(err) {
        if (err) {
            if (err.statusCode === 404) {
                self.log.info('NIC already deleted from NAPI');
                S.gotoState('stopped');
                return;
            }

            if (err.statusCode === 412) {
                self.log.info('NIC "Etag" changed in NAPI, refreshing');
                S.gotoState('release.refresh');
                return;
            }

            S.timeout(5000, function () {
                S.gotoState('release.delete');
            });
            return;
        }

        S.gotoState('stopped');
    }

    self.app.napi.deleteNic(self.mac, {}, {
        headers: {
            'If-Match': self.etag
        }
    }, S.callback(afterDelete));
};

NicFSM.prototype.state_release.refresh = function (S) {
    var self = this;

    function afterGet(err, nic, _, res) {
        if (err) {
            if (err.statusCode === 404) {
                S.gotoState('stopped');
                return;
            }

            self.log.warn(err,
                'Failed to refresh NIC information for release; ' +
                'retrying in 5 seconds');
            S.timeout(5000, function () {
                S.gotoState('release.refresh');
            });
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        self.log.info('Refreshed NIC release information');

        S.gotoState('release.delete');
    }

    self.log.info('Refreshing NIC release information');

    self.app.napi.getNic(self.mac, S.callback(afterGet));
};

NicFSM.prototype.state_stopped = function (S) {
    S.validTransitions([ ]);

    this.local = null;
    this.remote = null;
    this.etag = undefined;
};

NicFSM.prototype.setLocal = function (nic) {
    assert.object(nic, 'nic');
    var self = this;

    self.local = nic;

    if (self.pending.update) {
        return;
    }

    self.pending.update = true;
    setImmediate(function () {
        self.pending.update = false;
        self.emit('setAsserted');
    });
};

/**
 * Update our copy of the NIC in NAPI (as well as it's etag if the
 * NAPI instance is new enough to report it).
 */
NicFSM.prototype.setRemote = function (nic, etag) {
    assert.object(nic, 'nic');
    assert.optionalString(etag, 'etag');

    this.needVmUpdate = mod_common.hasChanged(VM_FIELDS, nic, this.remote);

    this.remote = nic;
    this.etag = etag;
    this.network = mod_jsprim.hasKey(nic, 'network_uuid')
        ? this.app.watchNet(nic.network_uuid)
        : null;
};

NicFSM.prototype.refresh = function (etag) {
    assert.optionalString(etag, 'etag');
    var self = this;

    if (etag && etag === self.etag) {
        return;
    }

    if (self.pending.refresh) {
        return;
    }

    self.pending.refresh = true;
    setImmediate(function () {
        self.pending.refresh = false;
        self.emit('refreshAsserted');
    });
};

NicFSM.prototype.releaseFrom = function (belongs_to_uuid) {
    assert.uuid(belongs_to_uuid, 'belongs_to_uuid');
    this.released = belongs_to_uuid;
    this.emit('releaseAsserted', belongs_to_uuid);
};

module.exports = NicFSM;