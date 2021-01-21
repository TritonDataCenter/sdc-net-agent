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

var NAPI_FIELDS = [
    'allow_dhcp_spoofing',
    'allow_ip_spoofing',
    'allow_mac_spoofing',
    'allow_restricted_traffic',
    'allow_unfiltered_promisc',
    'gateway',
    'model',
    'mtu',
    'netmask',
    'network_uuid',
    'nic_tag',
    'primary',
    'ip',
    'vlan_id'
];

/*
 * We only attempt to update VMs when they are in these states, so that we
 * avoid touching (re)provisioning VMs.
 */
var UPDATE_STATES = [
    'running',
    'stopped'
];

// --- Exports

/**
 * The InstanceFSM is responsible for tracking changes related to a single VM
 * and its NICs. When a VM's state changes we push any relevant info up to NAPI.
 * Alternatively, when NAPI state changes (new routes, for example), then we
 * need to take care of updating the VM to match.
 *
 * The state machine looks like the following (note that retries aren't
 * depicted here, but are loops back into the same state usually).
 *
 *                           +-------------------------------------+
 *                           |               update()              |
 *                           v                                     |
 *   +------+           +--------+          +-------------+ -------+
 *   | init | --------> | update | -------> | update.wait |        |
 *   +------+           +--------+          +-------------+ --+    |
 *                           ^                     |          |    |
 *                           |                     |          |    |
 *                           | update()            |          |    |
 *                           |                     v          |    |
 * +--------+  remove() +---------+         +-------------+ --|----+
 * | remove | <-------- | waiting | <------ |  update.vm  |   |
 * +--------+           +---------+         +-------------+ --+
 *     ^                                                      |
 *     |                     remove()                         |
 *     +------------------------------------------------------+
 */
function InstanceFSM(opts) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.vm, 'opts.vm');
    assert.ok(['object', 'function']
        .indexOf(typeof (opts.vmadm)) !== -1, 'opts.vmadm');

    this.uuid = opts.uuid;
    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'instance',
        uuid: this.uuid
    }, true);

    this.nics = {};
    this.vm = null;
    this.vmadm = opts.vmadm;

    this._update(opts.vm);

    mod_common.CommonFSM.call(this);
}
mod_util.inherits(InstanceFSM, mod_common.CommonFSM);

InstanceFSM.prototype.state_init = function (S) {
    S.gotoState('update');
};

InstanceFSM.prototype.state_waiting = function (S) {
    S.validTransitions([
        'stop',
        'update',
        'remove'
    ]);

    S.gotoStateOn(this, 'stopAsserted', 'stop');
    S.gotoStateOn(this, 'updateAsserted', 'update');
    S.gotoStateOn(this, 'removeAsserted', 'remove');
};

InstanceFSM.prototype.state_update = function (S) {
    if (UPDATE_STATES.indexOf(this.vm.state) === -1) {
        /*
         * If the VM isn't in one of the states in which it's okay for us
         * to update it (e.g., "provisioning"), then we return to state
         * "waiting" until the VM is safe to update.
         */
        this.log.debug({
            state: this.vm.state
        }, 'Skipping updating VM in state %j', this.vm.state);
        S.gotoState('waiting');
        return;
    }

    S.gotoStateOn(this, 'removeAsserted', 'remove');

    S.gotoState('update.wait');
};

/**
 * Check that all of this instance's NICs have completed their first refresh.
 * If they have, we can go ahead and compare target routes with the current
 * set. Otherwise, wait until the NIC moves into state "update", and then
 * try again.
 */
InstanceFSM.prototype.state_update.wait = function (S) {
    var pending = null;

    for (var mac in this.nics) {
        if (!mod_jsprim.hasKey(this.nics, mac)) {
            continue;
        }

        if (this.nics[mac].remote === null) {
            pending = this.nics[mac];
            break;
        }
    }

    if (pending === null) {
        S.gotoState('update.vm');
        return;
    }

    S.gotoStateOn(this, 'stopAsserted', 'stop');
    S.gotoStateOn(this, 'updateAsserted', 'update');

    S.on(pending, 'stateChanged', function onStateChange() {
        if (pending.remote === null) {
            return;
        }

        S.gotoState('update.wait');
    });
};

InstanceFSM.prototype.state_update.vm = function (S) {
    var self = this;
    var updated = false;

    var current = Object.assign({}, this.vm.routes);
    var resolvers = [];
    var target = {};

    function addResolver(resolver) {
        if (resolvers.indexOf(resolver) === -1) {
            resolvers.push(resolver);
        }
    }

    S.gotoStateOn(this, 'stopAsserted', 'stop');

    mod_jsprim.forEachKey(this.nics, function (_, nfsm) {
        if (nfsm.remote.routes) {
            Object.assign(target, nfsm.remote.routes);
        }

        if (self.vm.no_nic_resolvers) {
            self.log.debug('ignoring resolvers - no_nic_resolvers is set');
        } else if (Array.isArray(nfsm.remote.resolvers)) {
            nfsm.remote.resolvers.forEach(addResolver);
        }
    });

    mod_jsprim.forEachKey(target, function (dst, gw) {
        if (current[dst] === gw) {
            delete target[dst];
        }

        delete current[dst];
    });

    var remove = Object.keys(current);

    if (remove.length === 0 &&
        mod_jsprim.isEmpty(target) &&
        (this.vm.no_nic_resolvers ||
            mod_jsprim.deepEqual(resolvers, this.vm.resolvers))) {
        S.gotoState('waiting');
        return;
    }

    S.on(self, 'updateAsserted', function () {
        /*
         * Wait until our `vmadm update' finishes running, so that our updates
         * are always ordered one after the other.
         */
        updated = true;
    });

    function afterUpdate(err) {
        if (err) {
            self.log.error(err, 'Failed to update networking info for VM');
            self.app.watcher.refresh();
        }

        if (updated) {
            S.gotoState('update');
        } else {
            S.gotoState('waiting');
        }
    }

    var payload = {
        uuid: self.uuid,
        resolvers: resolvers,
        set_routes: target,
        remove_routes: remove
    };

    self.log.info({ payload: payload },
        'Updating networking information for VM');

    payload.log = self.log;

    self.vmadm.update(payload, S.callback(afterUpdate));
};


InstanceFSM.prototype.state_remove = function (S) {
    var self = this;

    S.validTransitions([
        'stop',
        'update'
    ]);

    mod_jsprim.forEachKey(self.nics, function (mac, _) {
        self.app.releaseNic(mac, self.uuid);
    });

    self.nics = {};
    self.vm = null;

    S.gotoStateOn(this, 'stopAsserted', 'stop');
    S.gotoStateOn(this, 'updateAsserted', 'update');
};


/**
 * Stop (but don't remove) the underlying NICs. This is the end of the FSM.
 */
InstanceFSM.prototype.state_stop = function (S) {
    var self = this;

    S.validTransitions([ ]);

    mod_jsprim.forEachKey(self.nics, function (mac, nfsm) {
        self.log.debug({mac: mac, vm: self.uuid}, 'Stopping nic-fsm');
        nfsm.stop();
    });

    self.nics = {};
    self.vm = null;

    self.log.info('Stopped tracking of VM %s', self.uuid);
};


InstanceFSM.prototype._update = function (vm) {
    var self = this;
    var prev = self.nics;

    self.vm = {
        state: vm.state,
        // TRITON-1886 Honour custom DNS resolvers by checking no_nic_resolvers.
        no_nic_resolvers: (vm.internal_metadata || {}).no_nic_resolvers,
        owner_uuid: vm.owner_uuid,
        resolvers: vm.resolvers,
        routes: vm.routes,
        zone_state: vm.zone_state
    };
    self.nics = {};

    vm.nics.forEach(function (nic) {
        var mac = nic.mac;
        var nfsm;

        if (mod_jsprim.hasKey(prev, mac)) {
            nfsm = prev[mac];
            delete prev[mac];
        } else {
            self.log.info('NIC %s added to VM %s', mac, self.uuid);
            nfsm = self.app.watchNic(mac);
        }

        nfsm.setLocal(self._fmtnic(nic));

        self.nics[mac] = nfsm;
    });

    mod_jsprim.forEachKey(prev, function (mac, _) {
        self.log.info('NIC %s removed from VM %s', mac, self.uuid);
        self.app.releaseNic(mac, self.uuid);
    });
};

InstanceFSM.prototype._fmtstate = function (state) {
    return (state === 'running' ? 'running' : 'stopped');
};

InstanceFSM.prototype._fmtnic = function (nic) {
    var o = {
        cn_uuid: this.app.cn_uuid,
        belongs_to_uuid: this.uuid,
        belongs_to_type: 'zone',
        owner_uuid: this.vm.owner_uuid,
        state: this._fmtstate(this.vm.state)
    };

    NAPI_FIELDS.forEach(function (field) {
        if (mod_jsprim.hasKey(nic, field)) {
            o[field] = nic[field];
        }
    });

    return o;
};

InstanceFSM.prototype.update = function (vm) {
    assert.object(vm, 'vm');
    var self = this;

    self._update(vm);
    self.emitDelayed('updateAsserted', 0);
};

/**
 * Since instance data is tracked collectively, and not individually, we need
 * to ask the watcher to handle the refresh for us to make sure we have the
 * latest information. This will then make us pass through the "update" state,
 * and compare the system's data with our expectations.
 */
InstanceFSM.prototype.refresh = function () {
    this.app.watcher.refresh();
};

InstanceFSM.prototype.remove = function () {
    this.emit('removeAsserted');
};

InstanceFSM.prototype.addNIC = function (mac, nic, callback) {
    var self = this;

    nic.mac = mac;

    self.vmadm.update({
        uuid: self.uuid,
        add_nics: [ nic ],
        log: self.log
    }, function (err) {
        self.refresh();
        callback(err);
    });
};

InstanceFSM.prototype.updateNIC = function (mac, update, callback) {
    var self = this;

    self.log.info({ payload: update },
        'Updating NIC %s on VM %s', mac, self.uuid);

    update.mac = mac;

    self.vmadm.update({
        uuid: self.uuid,
        update_nics: [ update ],
        log: self.log
    }, function (err) {
        self.refresh();
        callback(err);
    });
};

InstanceFSM.prototype.removeNIC = function (mac, callback) {
    var self = this;

    self.log.info('Removing NIC %s on VM %s', mac, self.uuid);

    self.vmadm.update({
        uuid: self.uuid,
        remove_nics: [ mac ],
        log: self.log
    }, function (err) {
        self.refresh();
        callback(err);
    });
};

InstanceFSM.prototype.reboot = function (callback) {
    var self = this;

    self.log.info('Rebooting VM %s', self.uuid);

    self.vmadm.reboot({
        uuid: self.uuid,
        log: self.log
    }, function (err) {
        self.refresh();
        callback(err);
    });
};

InstanceFSM.prototype.stop = function () {
    this.emit('stopAsserted');
};

module.exports = InstanceFSM;
