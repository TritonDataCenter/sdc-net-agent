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
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var mod_util = require('util');
var vmadm = require('vmadm');

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


// --- Exports

/**
 * The InstanceFSM is responsible for tracking changes related to a single VM
 * and its NICs. When a VM's state changes we push any relevant info up to NAPI.
 * Alternatively, when NAPI state changes (new routes, for example), then we
 * need to take care of updating the VM to match.
 */
function InstanceFSM(opts) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.vm, 'opts.vm');

    this.uuid = opts.uuid;
    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'instance',
        uuid: this.uuid
    }, true);

    this.pending = {
        refresh: false
    };

    this.nics = {};
    this.vm = null;

    this._update(opts.vm);

    mod_mooremachine.FSM.call(this, 'update');
}
mod_util.inherits(InstanceFSM, mod_mooremachine.FSM);

InstanceFSM.prototype.state_waiting = function (S) {
    S.validTransitions([
        'update',
        'remove'
    ]);

    S.on(this, 'updateAsserted', function () {
        S.gotoState('update');
    });

    S.on(this, 'removeAsserted', function () {
        S.gotoState('remove');
    });
};

InstanceFSM.prototype.state_update = function (S) {
    S.on(this, 'updateAsserted', function () {
        S.gotoState('update');
    });

    S.on(this, 'removeAsserted', function () {
        S.gotoState('remove');
    });

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

    S.on(pending, 'stateChanged', function onStateChange() {
        if (pending.remote === null) {
            return;
        }

        S.gotoState('update.wait');
    });
};

InstanceFSM.prototype.state_update.vm = function (S) {
    var self = this;

    var current = Object.assign({}, this.vm.routes);
    var resolvers = [];
    var target = {};

    function addResolver(resolver) {
        if (resolvers.indexOf(resolver) === -1) {
            resolvers.push(resolver);
        }
    }

    mod_jsprim.forEachKey(this.nics, function (_, nfsm) {
        if (nfsm.remote.routes) {
            Object.assign(target, nfsm.remote.routes);
        }

        if (Array.isArray(nfsm.remote.resolvers)) {
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
        mod_jsprim.deepEqual(resolvers, this.vm.resolvers)) {
        S.gotoState('waiting');
        return;
    }

    function afterUpdate(err) {
        if (err) {
            self.log.error(err, 'Failed to update networking info for VM');
            self.app.watcher.refresh();
        }

        S.gotoState('waiting');
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

    vmadm.update(payload, S.callback(afterUpdate));
};


InstanceFSM.prototype.state_remove = function (S) {
    var self = this;

    S.validTransitions([
        'update'
    ]);

    mod_jsprim.forEachKey(self.nics, function (mac, _) {
        self.app.releaseNic(mac, self.uuid);
    });

    self.nics = {};
    self.vm = null;

    S.on(this, 'updateAsserted', function () {
        S.gotoState('update');
    });
};


InstanceFSM.prototype._update = function (vm) {
    var self = this;
    var prev = self.nics;

    self.vm = {
        state: vm.state,
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

    if (self.pending.update) {
        return;
    }

    self.pending.update = true;
    setImmediate(function () {
        self.pending.update = false;
        self.emit('updateAsserted');
    });
};

InstanceFSM.prototype.refresh = function () {
    this.app.watcher.refresh();
};

InstanceFSM.prototype.remove = function () {
    this.emit('removeAsserted');
};

InstanceFSM.prototype.addNIC = function (mac, nic, callback) {
    var self = this;

    nic.mac = mac;

    vmadm.update({
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

    vmadm.update({
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

    vmadm.update({
        uuid: self.uuid,
        remove_nics: [ mac ],
        log: self.log
    }, function (err) {
        self.refresh();
        callback(err);
    });
};

module.exports = InstanceFSM;
