/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Test configuration
 */

'use strict';

var fs = require('fs');


// --- Globals

var CONFIG_PATH = '/opt/smartdc/agents/etc/net-agent.config.json';


// --- Exports

var CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH));

module.exports = CONFIG;
