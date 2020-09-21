/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 *
 * net-agent
 * =========
 *
 * The networking agent is responsible for syncing information between NAPI
 * and Compute Nodes. Unlike other aspects of Triton, such as disk space
 * availability, memory usage, and so on, the Compute Node is not the source
 * of truth for networking configuration. Changes to properties like a network's
 * gateway or resolvers need to be rolled out to VMs as soon as they happen.
 * As NAPI's boots on the ground, net-agent takes care of updating VMs as it
 * becomes aware of changes to networks and NICs.
 *
 * Unfortunately, some networking changes require a reboot in order for them
 * to take effect (this is especially true of many hardware VM images), so we
 * leave the timing of the reboot up to the VM owner. The notable exception to
 * this is when we detect that a VM has a NIC that belongs to someone else, in
 * which case we need to remove the NIC and reboot it to avoid hitting
 * Duplicate Address Detection issues.
 *
 * When a VM gets destroyed (either by VMAPI or an operator tool like vmadm or
 * zoneadm), then net-agent is responsible for telling NAPI that the NIC that
 * used to belong to that VM should be destroyed. (The VMAPI "destroy" workflow
 * will also make an effort to do this -- and could perhaps beat us to the
 * punch -- but we do it here too in case someone is using vmadm(1M) to remove
 * a VM.)
 *
 * Monitor FSMs
 * ------------
 *
 * net-agent has several finite state machines that it uses for tracking local
 * and remote state. From a high level, they do the following:
 *
 *  - Waiting
 *  - Refreshing
 *  - Update
 *
 * Each FSM is solely responsible for tracking the state of its object. This is
 * to ensure that the updates for an object are correctly ordered, and to
 * simplify the logic for performing retries. (As an example, net-agent used to
 * exponentially back off on retries, and the backed off request would
 * eventually overwrite an update that came later.)
 *
 * Tracking VM changes
 * -------------------
 *
 * On a platform with `vmadm events` (vminfod) support, the `vmadm-watcher-fsm`
 * is used to track changes by consuming the events API. `net-agent` listens
 * for changes relevant to the networking properties of the VM.
 *
 * On a platform without `vmadm events` (vminfod) support, net-agent loads all
 * of VMs that are located on the same CN as it is, by executing `vmadm
 * lookup`, and storing the VM objects in memory, each one tracked by a
 * separate InstanceFSM.
 *
 * net-agent listens for VM events by executing a child `zoneevent` command,
 * and processing the JSON that it produces on stdout. `zoneevent` emits output
 * whenever a property of the zone has changed. Note that it does not report
 * higher-level VM properties (that are used by vmadm and VMAPI). As net-agent
 * receives VM configuration updates, it tells each InstanceFSM to recalculate
 * its NIC states.
 */

'use strict';

var assert = require('assert-plus');
var mod_changefeed = require('changefeed');
var mod_clients = require('sdc-clients');
var mod_common = require('./common');
var mod_cueball = require('cueball');
var mod_jsprim = require('jsprim');
var os = require('os');
var mod_util = require('util');
var VError = require('verror');
var vmadm = require('vmadm');

var AggrFSM = require('./aggr-fsm');
var NetworkFSM = require('./net-fsm');
var NicFSM = require('./nic-fsm');
var InstanceFSM = require('./inst-fsm');
var ServerFSM = require('./server-fsm');
var WatcherFSM = require('./watcher-fsm');
var VmadmWatcherFSM = require('./vmadm-watcher-fsm');
var determineEventSource = require('./event-source');

// --- Internal helpers

function refreshFSM(_, fsm) {
    fsm.refresh();
}


// --- Exports

function NetAgent(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.uuid(options.cn_uuid, 'options.cn_uuid');
    assert.uuid(options.agent_uuid, 'options.agent_uuid');
    assert.uuid(options.admin_uuid, 'options.admin_uuid');
    assert.object(options.napi, 'options.napi');
    assert.string(options.napi.url, 'options.napi.url');
    assert.object(options.cueballAgent, 'options.cueballAgent');
    assert.optionalFunc(options.loadSysinfo, 'options.loadSysinfo');
    assert.object(options.sysinfo, 'options.sysinfo');

    this.options = options;
    this.log = options.log;
    this.cn_uuid = options.cn_uuid;
    this.agent_uuid = options.agent_uuid;
    this.admin_uuid = options.admin_uuid;
    this.version = mod_common.getNetAgentVersion();
    this.vmadm = options.vmadm || vmadm;
    this.sysinfo = options.sysinfo;

    // Depending on the backend vmadm might be an object or a function.
    assert.ok(['object', 'function']
        .indexOf(typeof (this.vmadm)) !== -1, 'options.vmadm');

    if (typeof (this.vmadm) === 'function') {
        this.vmadm = new vmadm({
            uuid: this.cn_uuid,
            log: this.log,
            sysinfo: this.sysinfo
        });
    }

    var userAgent = mod_util.format(
        'net-agent/%s (node/%s) server/%s',
        this.version, process.versions.node, this.cn_uuid);

    var cbopts = mod_jsprim.mergeObjects(options.cueballAgent, {
        log: this.log.child({ component: 'cueball' })
    });

    var serverfsmopts = {
        uuid: this.cn_uuid,
        app: this
    };

    if (options.loadSysinfo !== undefined) {
        serverfsmopts.loadSysinfo = options.loadSysinfo;
    }

    this.cueballAgent = new mod_cueball.HttpAgent(cbopts);

    this.napi = new mod_clients.NAPI({
        url: options.napi.url,
        log: options.log,
        agent: this.cueballAgent,
        retry: false,
        userAgent: userAgent
    });

    this.watcher = null;
    this.eventSource = null;

    this.feed = mod_changefeed.createListener({
        log: this.log.child({
            component: 'changefeed',
            level: 'info'
        }),
        url: options.napi.url,
        instance: this.agent_uuid,
        service: 'net-agent',
        resources: [
            {
                resource: 'network',
                subResources: [
                    'create',
                    'delete',
                    'gateway',
                    'resolvers',
                    'routes'
                ]
            },
            {
                resource: 'nic',
                subResources: [
                    'create',
                    'delete',
                    'allow_dhcp_spoofing',
                    'allow_ip_spoofing',
                    'allow_mac_spoofing',
                    'allow_restricted_traffic',
                    'allow_unfiltered_promisc'
                ]
            },
            {
                resource: 'aggregation',
                subResources: [
                    'create',
                    'delete'
                ]
            }
        ],
        backoff: {
            maxTimeout: 30000,
            minTimeout: 5000,
            retries: Infinity
        }
    });

    this.server = new ServerFSM(serverfsmopts);
    this.aggrs = {};
    this.insts = {};
    this.nics = {};
    this.nets = {};

    mod_common.CommonFSM.call(this);
}
mod_util.inherits(NetAgent, mod_common.CommonFSM);

NetAgent.prototype.start = function () {
    this.emit('startAsserted');
};

NetAgent.prototype.stop = function () {
    this.emit('stopAsserted');
};

NetAgent.prototype.addVM = function (vm) {
    if (mod_jsprim.hasKey(this.insts, vm.uuid)) {
        this.insts[vm.uuid].refresh();
        return;
    }

    this.insts[vm.uuid] = new InstanceFSM({
        uuid: vm.uuid,
        vm: vm,
        app: this
    });
};

/*
 * Whenever WatcherFSM fetches a new list of VM configurations, we update all
 * of the corresponding InstanceFSMs to determine whether NICs have been added
 * or removed.
 *
 * In the case that a VM is destroyed, we remove the VM, which then releases
 * its NICs.
 */
NetAgent.prototype.updateVMs = function (vms) {
    var self = this;
    var prev = self.insts;

    self.insts = {};

    self.log.info({num_vms: vms.length}, 'updateVMs');

    vms.forEach(function (vm) {
        var vfsm;

        if (vm.do_not_inventory) {
            self.log.info({vm_uuid: vm.uuid},
                'Ignoring vm with do_not_inventory set');
            if (mod_jsprim.hasKey(prev, vm.uuid)) {
                /*
                 * TRITON-1814: Ignore network changes for vm's that are
                 * migrating. This is when a vm existed, but is now hidden by
                 * the do_not_inventory flag. Stop (and forget) the InstanceFSM.
                 */
                vfsm = prev[vm.uuid];
                delete prev[vm.uuid];
                vfsm.stop();
            }
            return;
        }

        if (mod_jsprim.hasKey(prev, vm.uuid)) {
            vfsm = prev[vm.uuid];
            vfsm.update(vm);

            delete prev[vm.uuid];
        } else {
            vfsm = new InstanceFSM({
                uuid: vm.uuid,
                vm: vm,
                vmadm: self.vmadm,
                app: self
            });
        }

        self.insts[vm.uuid] = vfsm;
    });

    mod_jsprim.forEachKey(prev, function (_, vm) {
        vm.remove();
    });
};

NetAgent.prototype.watchNet = function (uuid) {
    if (!mod_jsprim.hasKey(this.nets, uuid)) {
        this.nets[uuid] = new NetworkFSM({
            uuid: uuid,
            app: this
        });
    }

    return this.nets[uuid];
};

NetAgent.prototype.releaseNet = function (network_uuid) {
    if (!mod_jsprim.hasKey(this.nets, network_uuid)) {
        return;
    }

    this.nets[network_uuid].stop();
};

NetAgent.prototype.watchNic = function (mac) {
    if (!mod_jsprim.hasKey(this.nics, mac)) {
        this.nics[mac] = new NicFSM({
            app: this,
            mac: mac,
            vmadm: this.vmadm
        });
    }

    return this.nics[mac];
};

/**
 * Release a NIC in NAPI after it has been removed locally.
 */
NetAgent.prototype.releaseNic = function (mac, belongs_to_uuid) {
    if (!mod_jsprim.hasKey(this.nics, mac)) {
        return;
    }

    this.nics[mac].releaseFrom(belongs_to_uuid);
};

NetAgent.prototype.watchAggr = function (name) {
    if (!mod_jsprim.hasKey(this.aggrs, name)) {
        this.aggrs[name] = new AggrFSM({
            app: this,
            name: name,
            vmadm: this.vmadm
        });
    }

    return this.aggrs[name];
};

/**
 * Release an aggregation in NAPI after it has been removed locally.
 */
NetAgent.prototype.releaseAggr = function (name, belongs_to_uuid) {
    if (!mod_jsprim.hasKey(this.aggrs, name)) {
        return;
    }

    this.aggrs[name].releaseFrom(belongs_to_uuid);
};

NetAgent.prototype.state_init = function (S) {
    S.gotoStateOn(this, 'startAsserted', 'starting');
};

NetAgent.prototype.state_starting = function (S) {
    S.gotoStateOn(this, 'stopAsserted', 'stopping');

    S.gotoState('starting.determineEventSource');
};

NetAgent.prototype.state_starting.determineEventSource = function (S) {
    var self = this;

    determineEventSource({
        log: self.log,
        vmadm: self.vmadm
    }, function determinedEventSource(err, eventSource) {
        if (err) {
            self.log.error(err, 'error determining event source');
            S.gotoStateTimeout(1000, 'starting.determineEventSource');
            return;
        }

        self.log.info('determined best eventSource: %s', eventSource);
        self.eventSource = eventSource;

        S.gotoState('starting.startWatcher');
    });
};

NetAgent.prototype.state_starting.startWatcher = function (S) {
    S.validTransitions([ 'starting.watchfeeds' ]);

    if (os.platform() === 'linux') {
        S.gotoState('starting.watchfeeds');
        return;
    }

    switch (this.eventSource) {
    case 'default':
        this.watcher = new WatcherFSM({
            app: this,
            vmadm: this.vmadm
        });
        break;
    case 'vmadm-events':
        this.watcher = new VmadmWatcherFSM({
            app: this,
            vmadm: this.vmadm
        });
        break;
    default:
        throw new VError('unknown event source %j', this.eventSource);
    }

    this.watcher.start();

    S.gotoState('starting.watchfeeds');
};

NetAgent.prototype.state_starting.watchfeeds = function (S) {
    S.validTransitions([ 'running' ]);

    /*
     * Ideally we'd wait for the "bootstrap" event so we know
     * we're connected, but older NAPIs don't have changefeeds.
     */
    this.feed.register();

    S.gotoState('running');
};

NetAgent.prototype.state_running = function (S) {
    var self = this;

    S.validTransitions([ 'stopping' ]);

    S.on(self, 'stopAsserted', function () {
        S.gotoState('stopping');
    });

    /*
     * Watch events from the NAPI changefeed.
     */
    S.on(self.feed, 'readable', function onFeedReadable() {
        self._cfdrain();
    });

    S.on(self.feed, 'bootstrap', function onBootstrap(bsinfo) {
        self._cfbootstrap(bsinfo);
    });

    self._cfdrain();
};

NetAgent.prototype.state_stopping = function (S) {
    var self = this;

    S.validTransitions([ 'stopped' ]);

    self.feed.close();
    self.cueballAgent.stop();

    S.gotoState('stopped');
};

NetAgent.prototype.state_stopped = function (S) {
    S.validTransitions([ ]);
};

NetAgent.prototype._processAggr = function (change) {
    var aggr = this.aggrs[change.name];

    if (change.changeKind.subResources.indexOf('delete') !== -1) {
        if (aggr) {
            /*
             * XXX: Instead of relying on the subsequent 404, have a special
             * method.
             */
            aggr.refresh();
        }
        return;
    }

    if (aggr) {
        aggr.refresh();
        return;
    }

    if (change.belongs_to_uuid === this.cn_uuid) {
        this.watchAggr(change.name);
        return;
    }
};

NetAgent.prototype._processNetwork = function processNetwork(change) {
    if (!mod_jsprim.hasKey(this.nets, change.changedResourceId)) {
        return;
    }

    if (change.changeKind.subResources.indexOf('delete') !== -1) {
        this.releaseNet(change.changedResourceId);
        return;
    }

    this.nets[change.changedResourceId].refresh();
};

NetAgent.prototype._processNic = function processNic(change) {
    var mac = change.changedResourceId;
    var nic = this.nics[mac];

    if (change.changeKind.subResources.indexOf('delete') !== -1) {
        if (nic) {
            /*
             * XXX: Instead of relying on the subsequent 404, have a special
             * method.
             */
            nic.refresh();
        }
        return;
    }

    if (nic) {
        nic.refresh();
        return;
    }

    if (change.cn_uuid === this.cn_uuid) {
        this.watchNic(mac);
        return;
    }
};

NetAgent.prototype._cfdrain = function drainChangeFeed() {
    var change, resource;

    while ((change = this.feed.read()) !== null) {
        resource = change.changeKind.resource;

        switch (resource) {
        case 'aggregation':
            this._processAggr(change);
            break;
        case 'network':
            this._processNetwork(change);
            break;
        case 'nic':
            this._processNic(change);
            break;
        default:
            this.log.warn({ change: change },
                'unknown resource type %j', resource);
            break;
        }
    }
};

NetAgent.prototype._cfbootstrap = function bootstrapChangeFeed(bsinfo) {
    assert.object(bsinfo, 'bsinfo');

    switch (bsinfo.resource) {
    case 'aggregation':
        mod_jsprim.forEachKey(this.aggrs, refreshFSM);
        break;
    case 'network':
        mod_jsprim.forEachKey(this.nets, refreshFSM);
        break;
    case 'nic':
        mod_jsprim.forEachKey(this.nics, refreshFSM);
        break;
    default:
        this.log.warn({ bootstrap: bsinfo }, 'unrecognized bootstrap resource');
        break;
    }
};

module.exports = NetAgent;
