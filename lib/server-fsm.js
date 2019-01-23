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
var mod_forkexec = require('forkexec');
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var mod_util = require('util');

// --- Globals

var VNIC_NAME_RE = /^([a-zA-Z0-9_]{0,31})[0-9]+$/;

// --- Internal helpers

function loadSysinfo(callback) {
    mod_forkexec.forkExecWait({
        argv: [ '/usr/bin/sysinfo' ],
        includeStderr: true,
        timeout: 0
    }, function (err, info) {
        if (err) {
            callback(err);
            return;
        }

        var sysinfo;

        try {
            sysinfo = JSON.parse(info.stdout.trim());
        } catch (e) {
            callback(e);
            return;
        }

        callback(null, sysinfo);
    });
}


// --- Exports

function ServerFSM(opts) {
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');
    assert.object(opts.app, 'opts.app');
    assert.optionalFunc(opts.loadSysinfo, 'opts.loadSysinfo');

    this.uuid = opts.uuid;
    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'server',
        cn_uuid: this.uuid
    }, true);

    this.nics = {};
    this.aggrs = {};
    this.nictags = {};

    /*
     * Allow caller to pass in a function for loading sysinfo. Otherwise we'll
     * default to calling /usr/bin/sysinfo.
     */
    this.loadSysinfo = opts.loadSysinfo || loadSysinfo;

    mod_mooremachine.FSM.call(this, 'init');
}
mod_util.inherits(ServerFSM, mod_mooremachine.FSM);

ServerFSM.prototype.state_init = function (S) {
    S.validTransitions([ 'refresh' ]);

    S.gotoState('refresh');
};

ServerFSM.prototype.state_waiting = function (S) {
    S.validTransitions([ 'refresh' ]);

    S.on(this, 'refreshAsserted', function () {
        S.gotoState('refresh');
    });
};

ServerFSM.prototype.state_refresh = function (S) {
    var self = this;

    S.validTransitions([ 'refresh', 'waiting' ]);

    function retry(err) {
        self.log.error(err, 'failed to fetch new sysinfo');
        S.timeout(5000, function () {
            S.gotoState('refresh');
        });
    }

    self.loadSysinfo(function _onSysinfo(err, sysinfo) {
        if (err) {
            retry(err);
            return;
        }

        self._update(sysinfo);

        S.gotoState('waiting');
    });
};

ServerFSM.prototype._update = function (sysinfo) {
    var self = this;
    var prev = self.nics;

    self.nics = {};
    self.nictags = {};

    var pnics = sysinfo['Network Interfaces'];
    var vnics = sysinfo['Virtual Network Interfaces'];
    var aggrs = sysinfo['Link Aggregations'];

    function watchNic(mac, nic) {
        var nfsm;

        if (mod_jsprim.hasKey(prev, mac)) {
            nfsm = prev[mac];
            delete prev[mac];
        } else {
            self.log.info('NIC %s added to CN %s', mac, self.uuid);
            nfsm = self.app.watchNic(mac);
        }

        nfsm.setLocal(nic);

        self.nics[mac] = nfsm;
    }

    mod_jsprim.forEachKey(pnics, function (name, pnic) {
        if (mod_jsprim.hasKey(aggrs, name)) {
            return;
        }

        var mac = pnic['MAC Address'];

        pnic['NIC Names'].forEach(function (tag) {
            self.nictags[tag] = name;
        });

        watchNic(mac, self._fmtpnic(pnic, sysinfo));
    });

    mod_jsprim.forEachKey(vnics, function (name, vnic) {
        var mac = vnic['MAC Address'];

        watchNic(mac, self._fmtvnic(name, vnic));
    });

    mod_jsprim.forEachKey(aggrs, function (name, aggr) {
        var afsm = self.app.watchAggr(name);

        afsm.setLocal(self._fmtaggr(name, aggr, pnics));

        self.aggrs[name] = afsm;
    });

    mod_jsprim.forEachKey(prev, function (mac, nfsm) {
        self.log.info('NIC %s removed from CN %s', mac, self.uuid);

        nfsm.releaseFrom(self.uuid);
    });
};

ServerFSM.prototype._fmtstate = function (state) {
    return (state === 'up' ? 'running' : 'stopped');
};

ServerFSM.prototype._fmtpnic = function (nic, sysinfo) {
    var admin_tag = sysinfo['Admin NIC Tag'] || 'admin';
    var o = {
        belongs_to_uuid: this.uuid,
        belongs_to_type: 'server',
        owner_uuid: this.app.admin_uuid,
        state: this._fmtstate(nic['Link Status']),
        nic_tags_provided: nic['NIC Names']
    };

    if (nic.ip4addr) {
        o.ip = nic.ip4addr;
    }

    /* If this is an admin NIC, try to set "nic_tag" */
    if (nic['NIC Names'].indexOf(admin_tag) !== -1) {
        o.nic_tag = admin_tag;
        o.vlan_id = 0;
    }

    return o;
};

ServerFSM.prototype._findtag = function (name, host) {
    var m = VNIC_NAME_RE.exec(name);
    if (m === null) {
        return undefined;
    }

    if (this.nictags[m[1]] !== host) {
        /*
         * Under normal Triton operation this shouldn't happen, but if an
         * operator is modifying state in the GZ themselves with dladm(1M)
         * we could arrive here.
         */
        return undefined;
    }

    return m[1];
};

ServerFSM.prototype._fmtvnic = function (name, nic) {
    var o = {
        belongs_to_uuid: this.uuid,
        belongs_to_type: 'server',
        owner_uuid: this.app.admin_uuid,
        state: this._fmtstate(nic['Link Status'])
    };

    if (nic.ip4addr) {
        o.ip = nic.ip4addr;
    }

    if (mod_jsprim.hasKey(nic, 'VLAN')) {
        o.vlan_id = nic['VLAN'];
    } else {
        o.vlan_id = 0;
    }

    /* Extract the nic_tag for VNICs */
    o.nic_tag = this._findtag(name, nic['Host Interface']);

    return o;
};

ServerFSM.prototype._fmtaggr = function (name, aggr, pnics) {
    assert.string(name, 'name');
    assert.object(aggr, 'aggr');
    assert.object(pnics, 'pnics');

    var nic_tags_provided = pnics[name]['NIC Names'];

    var macs = aggr['Interfaces'].map(function (pname) {
        return pnics[pname]['MAC Address'];
    });

    return {
        id: mod_common.formatAggrId(this.app.cn_uuid, name),
        name: name,
        belongs_to_uuid: this.app.cn_uuid,
        lacp_mode: aggr['LACP mode'],
        nic_tags_provided: nic_tags_provided,
        macs: macs
    };
};

ServerFSM.prototype.refresh = function () {
    this.emit('refreshAsserted');
};

ServerFSM.prototype.addNIC = function (mac, payload, callback) {
    this.log.warn({ mac: mac, payload: payload },
        'Server NIC adds are currently unsupported');

    setImmediate(callback);
};

ServerFSM.prototype.updateNIC = function (mac, payload, callback) {
    this.log.warn({ mac: mac, payload: payload },
        'Server NIC updates are currently unsupported');

    setImmediate(callback);
};

ServerFSM.prototype.removeNIC = function (mac, payload, callback) {
    this.log.warn({ mac: mac, payload: payload },
        'Server NIC removals are currently unsupported');

    setImmediate(callback);
};

ServerFSM.prototype.updateAggr = function (name, payload, callback) {
    this.log.warn({ name: name, payload: payload },
        'Server aggregation updates are currently unsupported');

    setImmediate(callback);
};

module.exports = ServerFSM;
