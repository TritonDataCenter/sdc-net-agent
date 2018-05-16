/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_common = require('./common');
var mod_jsprim = require('jsprim');
var mod_util = require('util');

// --- Globals

var LOCAL_FIELDS = [
];

var REMOTE_FIELDS = [
];

// --- Internal helpers

function getDifferences(fields, cur, old) {
    var update = {};

    fields.forEach(function (field) {
        if (cur[field] !== old[field]) {
            update[field] = cur[field];
        }
    });

    return update;
}


// --- Exports

/**
 * The AggrFSM is responsible for tracking changes related to a single
 * aggregation located in a CN's global zone.
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
 *       +------+        +---------+               | +--<-- +--------+         |
 *                       |    ^    |               | |           |             |
 *          NAPI 404 for |    |    v               | |           |             |
 *          existing agg |    |    |               | |           |             |
 *       +---------+     |    |    |               | |           |             |
 *  +--> | remove  | <---+    |    +------->-------------->--------------------+
 *  |    +---------+          |                    | |           |             |
 *  |         |               |                    | v           |             v
 *  |         v               | called             | |           v             |
 *  |    +---------+          | refresh()          | |   +--------------+      |
 *  |    | stopped |          |                    | +-- | update.local | -->--+
 *  |    +---------+          |                    | |   +--------------+      |
 *  |         ^               |             called | v           |             |
 *  |         |               |         setLocal() | |           v             v
 *  |    +---------+     +---------+ -->-----------+ |   +--------------+      |
 *  |    | release |     | waiting |                 |   | update.napi  |      |
 *  |    +---------+     +---------+ <---------------+-- +--------------+ -->--+
 *  |         ^               |                                  |             |
 *  |         |               |                     NAPI 404 for |             |
 *  |         |               |                     existing agg |             |
 *  +---------|---------------|----------------------------------+             |
 *            |               |                                  releaseFrom() |
 *            +-------<-------+-----------------------<------------------------+
 */
function AggrFSM(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.app, 'opts.app');

    this.name = opts.name;
    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'aggr',
        aggr: this.name
    }, true);

    this.released = null;

    this.local = null;
    this.remote = null;

    /*
     * We track the "Etag" header so that we can be careful
     * about our DELETEs.
     */
    this.etag = undefined;

    mod_common.CommonFSM.call(this);
}
mod_util.inherits(AggrFSM, mod_common.CommonFSM);

AggrFSM.prototype.state_init = function (S) {
    S.immediate(function () {
        S.gotoState('refresh');
    });
};

/**
 * Wait for external events to force us to recompare.
 */
AggrFSM.prototype.state_waiting = function (S) {
    S.gotoStateOn(this, 'setAsserted', 'update');
    S.gotoStateOn(this, 'refreshAsserted', 'refresh');
    S.gotoStateOn(this, 'releaseAsserted', 'release');

    /*
     * Refresh periodically for installations w/o changefeed.
     */
    S.gotoStateTimeout(60 * 60 * 1000, 'refresh');
};

AggrFSM.prototype.state_refresh = function (S) {
    var self = this;

    S.validTransitions([
        'create',
        'refresh',
        'release',
        'remove',
        'update'
    ]);

    S.gotoStateOn(self, 'refreshAsserted', 'refresh');
    S.gotoStateOn(self, 'releaseAsserted', 'release');

    function afterGet(err, aggr, _, res) {
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
                'Failed to refresh aggregation information; ' +
                'retrying in 5 seconds');
            S.gotoStateTimeout(5000, 'refresh');
            return;
        }

        self.setRemote(aggr, res.headers['etag']);

        self.log.info('Refreshed aggregation information');

        S.gotoState('update');
    }

    self.app.napi.getAggr(self.getId(), S.callback(afterGet));
};

AggrFSM.prototype.state_create = function (S) {
    var self = this;
    var deleted = false;

    S.validTransitions([
        'refresh',
        'release',
        'update',
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

    function afterCreate(err, aggr, _, res) {
        if (deleted) {
            S.gotoState('release');
            return;
        }

        if (err) {
            self.log.warn(err,
                'Failed to create aggregation in NAPI; ' +
                'scheduling state refresh');
            S.gotoStateTimeout(5000, 'refresh');
            return;
        }

        self.setRemote(aggr, res.headers['etag']);

        S.gotoState('update');
    }

    self.log.info({ aggr: self.local }, 'Syncing local aggregation to NAPI');

    self.app.napi.createAggr(self.local, S.callback(afterCreate));
};

AggrFSM.prototype.state_update = function (S) {
    /*
     * We haven't seen a local aggr yet. Go to state "waiting" until
     * we're assigned one.
     */
    if (this.local === null) {
        this.log.debug('No local aggregation information yet');
        S.gotoState('waiting');
        return;
    }

    /*
     * If the belongs_to_uuid has changed, then we need to move the aggr.
     */
    if (this.local.belongs_to_uuid !== this.remote.belongs_to_uuid) {
        S.gotoState('remove');
        return;
    }

    S.gotoStateOn(this, 'refreshAsserted', 'refresh');

    S.gotoState('update.local');
};

AggrFSM.prototype.state_update.local = function (S) {
    var self = this;

    S.validTransitions([
        'release',
        'update.local',
        'update.napi',
        'waiting'
    ]);

    var locupdate = getDifferences(REMOTE_FIELDS, self.remote, self.local);
    if (mod_jsprim.isEmpty(locupdate)) {
        self.log.trace('No local changes needed');
        S.gotoState('update.napi');
        return;
    }

    S.gotoStateOn(this, 'releaseAsserted', 'release');

    function afterUpdate(err) {
        if (err) {
            self.log.error(err, 'Failed to update aggregation %s',
                self.name);
            S.gotoState('update.local');
            return;
        }

        S.gotoState('update.napi');
    }

    self.app.server.updateAggr(self.getId(), locupdate,
        S.callback(afterUpdate));
};

AggrFSM.prototype.state_update.napi = function (S) {
    var self = this;

    S.validTransitions([
        'release',
        'remove',
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

    function afterPut(err, aggr, _, res) {
        if (err) {
            if (err.statusCode === 404) {
                self.log.warn('Aggregation no longer in NAPI, removing');
                S.gotoState('remove');
                return;
            }

            self.log.error(err,
                'Failed to update aggregation in NAPI; ' +
                'retrying in 5 seconds');
            S.gotoStateTimeout(5000, 'update.napi');
            return;
        }

        self.setRemote(aggr, res.headers['etag']);

        S.gotoState('update');
    }

    self.log.info({ payload: remupdate }, 'Updating aggregation in NAPI');

    self.app.napi.updateAggr(self.getId(), remupdate, S.callback(afterPut));
};

AggrFSM.prototype.state_remove = function (S) {
    S.validTransitions([
        'stopped'
    ]);

    S.gotoState('stopped');
};

AggrFSM.prototype.state_release = function (S) {
    S.validTransitions([
        'release.delete',
        'release.refresh',
        'stopped'
    ]);

    S.gotoState('release.delete');
};

AggrFSM.prototype.state_release.delete = function (S) {
    var self = this;

    if (self.remote === null) {
        S.gotoState('release.refresh');
        return;
    }

    if (self.released !== self.remote.belongs_to_uuid) {
        self.log.info('Skipping aggregation deletion, ' +
            'since upstream belongs_to_uuid has changed');
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
                self.log.info('Aggregation already deleted from NAPI');
                S.gotoState('stopped');
                return;
            }

            if (err.statusCode === 412) {
                self.log.info('Aggregation "Etag" changed in NAPI, refreshing');
                S.gotoState('release.refresh');
                return;
            }

            S.gotoStateTimeout(5000, 'release.delete');
            return;
        }

        S.gotoState('stopped');
    }

    self.app.napi.deleteAggr(self.getId(), {}, {
        headers: {
            'If-Match': self.etag
        }
    }, S.callback(afterDelete));
};

AggrFSM.prototype.state_release.refresh = function (S) {
    var self = this;

    function afterGet(err, aggr, _, res) {
        if (err) {
            if (err.statusCode === 404) {
                S.gotoState('stopped');
                return;
            }

            self.log.warn(err,
                'Failed to refresh aggregation information for release; ' +
                'retrying in 5 seconds');
            S.gotoStateTimeout(5000, 'release.refresh');
            return;
        }

        self.setRemote(aggr, res.headers['etag']);

        self.log.info('Refreshed aggregation release information');

        S.gotoState('release.delete');
    }

    self.log.info('Refreshing aggregation release information');

    self.app.napi.getAggr(self.getId(), S.callback(afterGet));
};

AggrFSM.prototype.state_stopped = function (S) {
    S.validTransitions([ ]);

    this.local = null;
    this.remote = null;
    this.etag = undefined;

    delete this.app.aggrs[this.name];
};

AggrFSM.prototype.getId = function () {
    return mod_common.formatAggrId(this.app.cn_uuid, this.name);
};

AggrFSM.prototype.setLocal = function (aggr) {
    assert.object(aggr, 'aggr');
    var self = this;

    self.local = aggr;
    self.emitDelayed('setAsserted', 0);
};

/**
 * Update our copy of the aggregation in NAPI (as well as its etag if the
 * NAPI instance is new enough to report it).
 */
AggrFSM.prototype.setRemote = function (aggr, etag) {
    assert.object(aggr, 'aggr');
    assert.optionalString(etag, 'etag');
    this.remote = aggr;
    this.etag = etag;
};

AggrFSM.prototype.refresh = function (etag) {
    assert.optionalString(etag, 'etag');
    var self = this;

    if (etag && etag === self.etag) {
        return;
    }

    self.emitDelayed('refreshAsserted', 0);
};

AggrFSM.prototype.releaseFrom = function (belongs_to_uuid) {
    assert.uuid(belongs_to_uuid, 'belongs_to_uuid');
    this.released = belongs_to_uuid;
    this.emit('releaseAsserted', belongs_to_uuid);
};

module.exports = AggrFSM;
