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
var mod_common = require('./common');
var mod_jsprim = require('jsprim');
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
    'belongs_to_uuid',
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

        if (cur[field] !== old[field] && cur[field] !== undefined) {
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
 * located either on a VM or the CN's global zone. When locally-determined
 * fields (LOCAL_FIELDS) change locally, their new values are sent to NAPI.
 * When remotely-determined values (REMOTE_FIELDS and VM_FIELDS) change, the
 * local NIC is updated to match.
 *
 * The state machine looks like the following (note that retries aren't
 * depicted here, but are loops back into the same state usually).
 *
 *                                           releaseFrom()
 *                       +---------+ ------>-----------------------------------+
 *                       | create  |                                           |
 *                       +---------+ ------>---------------------+             |
 *                 404 on 1st ^                                  |             |
 *                    refresh |                                  v             |
 *       +------+        +---------+ ------>-------+------> +--------+         |
 *       | init | -----> | refresh |               |        | update |         v
 *       +------+        +---------+               | +--<-- +--------+ -----+  |
 *                       |    ^    |               | |           |   booter |  |
 *          NAPI 404 for |    |    v               | |           |  created |  |
 *          existing NIC |    |    |               | |           |   CN NIC |  |
 *       +---------+     |    |    |               | |           |          |  |
 *  +--> | remove  | <---+    |    +------->-------------->--------------------+
 *  |    +---------+          |                    | |           |          |  |
 *  |         |               |                    | v           |          |  v
 *  |         v               | called             | |           v          |  |
 *  |    +---------+          | refresh()          | |   +--------------+   |  |
 *  |    | stopped |          |                    | +-- | update.local | --|--+
 *  |    +---------+          |                    | |   +--------------+   |  |
 *  |         ^               |             called | v           |          |  |
 *  |         |               |         setLocal() | |           v          |  v
 *  |    +---------+     +---------+ -->-----------+ |   +--------------+ <-+  |
 *  |    | release |     | waiting |                 |   | update.napi  |      |
 *  |    +---------+     +---------+ <---------------+-- +--------------+ -->--+
 *  |         ^               |                                  |             |
 *  |         |               |                     NAPI 404 for |             |
 *  |         |               |                     existing NIC |             |
 *  +---------|---------------|----------------------------------+             |
 *            |               |                                  releaseFrom() |
 *            +-------<-------+-----------------------<------------------------+
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

    mod_common.CommonFSM.call(this);
}
mod_util.inherits(NicFSM, mod_common.CommonFSM);

NicFSM.prototype.state_init = function (S) {
    S.immediate(function () {
        S.gotoState('refresh');
    });
};

/**
 * Wait for external events to force us to recompare.
 */
NicFSM.prototype.state_waiting = function (S) {
    S.gotoStateOn(this, 'setAsserted', 'update');
    S.gotoStateOn(this, 'stopAsserted', 'stopped');
    S.gotoStateOn(this, 'refreshAsserted', 'refresh');
    S.gotoStateOn(this, 'releaseAsserted', 'release');

    /*
     * Refresh periodically for installations w/o changefeed.
     *
     * Since most of our important attributes live on the network object, we
     * wait an hour to check here, and rely on the network information refresh
     * to let us know when something important changes. If NIC-specific
     * properties like spoofing parameters change, we'll eventually fix them.
     */
    S.gotoStateTimeout(60 * 60 * 1000, 'refresh');

    if (this.network !== null) {
        S.gotoStateOn(this.network, 'changed', 'refresh');
    }
};

NicFSM.prototype.state_refresh = function (S) {
    var self = this;

    S.validTransitions([
        'create',
        'refresh',
        'release',
        'remove',
        'stopped',
        'update'
    ]);

    S.gotoStateOn(self, 'refreshAsserted', 'refresh');
    S.gotoStateOn(self, 'releaseAsserted', 'release');
    S.gotoStateOn(this, 'stopAsserted', 'stopped');

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
            S.gotoStateTimeout(5000, 'refresh');
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        self.log.info('Refreshed NIC information');

        S.gotoState('update');
    }

    self.app.napi.getNic(self.mac, S.callback(afterGet));
};

/**
 * In "create", we take care of pushing the local NIC to NAPI. This is usually
 * not needed in normal Triton operation except just after installation when
 * the NICs for the Triton service zones and headnode need to be created in the
 * brand new NAPI service.
 *
 * When we POST the NIC, NAPI will send back our first copy of the remote NIC,
 * which will include information like the "network_uuid". We then go to the
 * "update" state so that we can backfill the VMs with these properties.
 */
NicFSM.prototype.state_create = function (S) {
    var self = this;
    var deleted = false;

    S.validTransitions([
        'refresh',
        'release',
        'stopped',
        'update',
        'waiting'
    ]);

    if (self.local === null) {
        S.gotoState('waiting');
        return;
    }

    S.gotoStateOn(this, 'stopAsserted', 'stopped');

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
            S.gotoStateTimeout(5000, 'refresh');
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        S.gotoState('update');
    }

    var remcreate = Object.assign({ check_owner: false }, self.local);

    self.log.info({ nic: remcreate }, 'Syncing local NIC to NAPI');

    self.app.napi.createNic(self.mac, remcreate, S.callback(afterCreate));
};

NicFSM.prototype.state_update = function (S) {
    S.validTransitions([
        'refresh',
        'remove',
        'stopped',
        'update.local',
        'update.napi',
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
     * When a new CN is first booted, booter inserts a NAPI record for the admin
     * NIC which has:
     *
     *   belongs_to_type = other
     *   belongs_to_uuid = <admin user's UUID>
     *
     * if we see this for a NIC we "own", we should update NAPI so the type gets
     * corrected.
     */
    if (this.remote.belongs_to_type === 'other' &&
        this.remote.belongs_to_uuid === this.app.admin_uuid &&
        this.local.belongs_to_type === 'server') {
        this.log.info({
            nic: this.local
        }, 'found our NIC unclaimed in NAPI, claiming.');

        S.gotoState('update.napi');
        return;
    }

    /*
     * If the belongs_to_uuid has changed, then we need to move the NIC.
     */
    if (this.local.belongs_to_uuid !== this.remote.belongs_to_uuid) {
        S.gotoState('remove');
        return;
    }

    S.gotoStateOn(this, 'refreshAsserted', 'refresh');

    S.gotoState('update.local');
};

NicFSM.prototype.state_update.local = function (S) {
    var self = this;

    S.validTransitions([
        'release',
        'stopped',
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

    S.gotoStateOn(this, 'releaseAsserted', 'release');
    S.gotoStateOn(this, 'stopAsserted', 'stopped');

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

    if (!needNicUpdate) {
        /*
         * While the NIC doesn't need to be updated, VM_FIELDS properties
         * have changed, so the owner will want to refresh and update its
         * configuration if needed.
         */
        owner.refresh();
        S.gotoState('update.napi');
        return;
    }

    owner.updateNIC(self.mac, locupdate, S.callback(afterUpdate));
};

/**
 * In "update.napi", we push any deviating local fields up to NAPI. If both the
 * local and remote NIC objects match, then we don't need to do anything and
 * can go back to the "waiting" state.
 *
 * When we update NAPI, it returns its latest, updated view of the NIC. Since
 * this is effectively a "refresh", we take another pass through "update"
 * afterwards, so that we apply any remote changes. If nothing has changed,
 * then we'll pass through "update.local" and "update.napi" without doing
 * anything, finally returning to "waiting".
 *
 * We ignore any "setAsserted" events while in this state, since our trip back
 * through the "update" state afterwards will handle the local change, and so
 * that we wait for our PUT request to finish, thus ordering all of our
 * "update.napi" PUTs.
 */
NicFSM.prototype.state_update.napi = function (S) {
    var self = this;

    S.validTransitions([
        'release',
        'remove',
        'stopped',
        'update',
        'update.napi',
        'waiting'
    ]);

    var remupdate = getDifferences(LOCAL_FIELDS, self.local, self.remote);
    if (mod_jsprim.isEmpty(remupdate)) {
        self.log.trace('No remote changes needed');
        S.gotoState('waiting');
        return;
    }

    S.gotoStateOn(this, 'stopAsserted', 'stopped');

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
                self.log.warn('NIC no longer in NAPI, removing');
                S.gotoState('remove');
                return;
            }

            self.log.error(err,
                'Failed to update NIC in NAPI; ' +
                'retrying in 5 seconds');
            S.gotoStateTimeout(5000, 'update.napi');
            return;
        }

        self.setRemote(nic, res.headers['etag']);

        S.gotoState('update');
    }

    remupdate.check_owner = false;

    self.log.info({ payload: remupdate }, 'Updating NIC in NAPI');

    self.app.napi.updateNic(self.mac, remupdate, S.callback(afterPut));
};

/**
 * The "remove" state takes care of removing a local NIC, either because it has
 * disappeared from NAPI or because the owner listed in NAPI differs from who
 * owns it locally (suggesting that two different VMs on Triton CNs have the
 * same MAC address).
 */
NicFSM.prototype.state_remove = function (S) {
    S.gotoState('remove.nic');
};

NicFSM.prototype.state_remove.nic = function (S) {
    var self = this;

    S.validTransitions([
        'remove.nic',
        'remove.reboot',
        'stopped'
    ]);

    if (!mod_jsprim.hasKey(self.app.insts, self.local.belongs_to_uuid)) {
        self.log.info('VM %s has gone away; skipping removing NIC',
            self.local.belongs_to_uuid);
        S.gotoState('stopped');
        return;
    }

    S.gotoStateOn(this, 'stopAsserted', 'stopped');

    function afterRemove(err) {
        if (err) {
            self.log.error(err,
                'Failed to remove NIC from VM %s; ' +
                'retrying in 5 seconds',
                self.local.belongs_to_uuid);
            S.gotoStateTimeout(5000, 'remove.nic');
            return;
        }

        S.gotoState('remove.reboot');
    }

    self.app.insts[self.local.belongs_to_uuid].removeNIC(
        self.mac, S.callback(afterRemove));
};

NicFSM.prototype.state_remove.reboot = function (S) {
    var self = this;

    S.validTransitions([
        'remove.reboot',
        'stopped'
    ]);

    if (self.local.belongs_to_type === 'server') {
        self.log.trace('Skipping rebooting server %s',
            self.local.belongs_to_uuid);
        S.gotoState('stopped');
        return;
    }

    if (!mod_jsprim.hasKey(self.app.insts, self.local.belongs_to_uuid)) {
        self.log.info('VM %s has gone away; skipping rebooting VM',
            self.local.belongs_to_uuid);
        S.gotoState('stopped');
        return;
    }

    S.gotoStateOn(this, 'stopAsserted', 'stopped');

    function afterRemove(err) {
        if (err) {
            self.log.error(err,
                'Failed to reboot VM %s; ' +
                'retrying in 5 seconds',
                self.local.belongs_to_uuid);
            S.gotoStateTimeout(5000, 'remove.reboot');
            return;
        }

        S.gotoState('stopped');
    }

    self.app.insts[self.local.belongs_to_uuid].reboot(
        S.callback(afterRemove));
};

/**
 * The "release" state takes care of removing a NIC from NAPI when it has
 * been removed locally, either because the NIC has been removed from a VM,
 * or because the VM has been deleted.
 */
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

    S.gotoStateOn(this, 'stopAsserted', 'stopped');

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

            S.gotoStateTimeout(5000, 'release.delete');
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

    S.gotoStateOn(this, 'stopAsserted', 'stopped');

    function afterGet(err, nic, _, res) {
        if (err) {
            if (err.statusCode === 404) {
                S.gotoState('stopped');
                return;
            }

            self.log.warn(err,
                'Failed to refresh NIC information for release; ' +
                'retrying in 5 seconds');
            S.gotoStateTimeout(5000, 'release.refresh');
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

    this.log.info({mac: this.mac}, 'Stopped tracking NIC');

    delete this.app.nics[this.mac];
};

NicFSM.prototype.setLocal = function (nic) {
    assert.object(nic, 'nic');
    var self = this;

    self.local = nic;
    self.emitDelayed('setAsserted', 0);
};

/**
 * Update our copy of the NIC in NAPI (as well as its etag if the
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

    self.emitDelayed('refreshAsserted', 0);
};

NicFSM.prototype.releaseFrom = function (belongs_to_uuid) {
    assert.uuid(belongs_to_uuid, 'belongs_to_uuid');
    this.released = belongs_to_uuid;
    this.emit('releaseAsserted', belongs_to_uuid);
};

NicFSM.prototype.stop = function () {
    this.emit('stopAsserted');
};

module.exports = NicFSM;
