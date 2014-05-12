/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * index.js
 */

var VmAgent = require('./vm-agent');
var UpdateAgent = require('./update-agent');

module.exports = {
	VmAgent: VmAgent,
	UpdateAgent: UpdateAgent
};
