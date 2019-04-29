/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 */

/*
 * Tests that verify that NIC changes made in NAPI are reflected locally.
 */

'use strict';

var mod_common = require('../../lib/common');
var test = require('tape');

// --- Tests

test('Get net-agent version', function (t) {
    var version = mod_common.getNetAgentVersion();

    t.equal(typeof (version), 'string');
    t.end();
});

test('hasChanged() tests', function (t) {
    var OBJ1 = { a: 5, b: [ 1, 2, 3, 4 ] };
    var OBJ2 = { a: 6, b: [ 1, 2, 3, 4 ] };
    var OBJ3 = { a: 5, b: [ 1, 2, 3, 5 ] };

    t.equal(mod_common.hasChanged([], OBJ1, null), true);
    t.equal(mod_common.hasChanged([ 'a' ], OBJ1, OBJ2), true);
    t.equal(mod_common.hasChanged([ 'b' ], OBJ1, OBJ3), true);

    t.equal(mod_common.hasChanged([ 'a', 'b' ], OBJ1, OBJ3), true);
    t.equal(mod_common.hasChanged([ 'a', 'b' ], OBJ1, OBJ2), true);
    t.equal(mod_common.hasChanged([ 'a', 'b' ], OBJ2, OBJ3), true);

    t.equal(mod_common.hasChanged([ 'a', 'b', 'c' ], OBJ1, OBJ3), true);
    t.equal(mod_common.hasChanged([ 'a', 'b', 'c' ], OBJ1, OBJ2), true);
    t.equal(mod_common.hasChanged([ 'a', 'b', 'c' ], OBJ2, OBJ3), true);

    t.equal(mod_common.hasChanged([], {}, {}), false);
    t.equal(mod_common.hasChanged([], OBJ1, OBJ2), false);
    t.equal(mod_common.hasChanged([ 'a' ], OBJ1, OBJ3), false);
    t.equal(mod_common.hasChanged([ 'b' ], OBJ1, OBJ2), false);
    t.equal(mod_common.hasChanged([ 'c' ], OBJ1, OBJ2), false);

    t.equal(mod_common.hasChanged([], OBJ1, OBJ1), false);
    t.equal(mod_common.hasChanged([ 'a' ], OBJ1, OBJ1), false);
    t.equal(mod_common.hasChanged([ 'b' ], OBJ1, OBJ1), false);
    t.equal(mod_common.hasChanged([ 'c' ], OBJ1, OBJ1), false);

    t.end();
});
