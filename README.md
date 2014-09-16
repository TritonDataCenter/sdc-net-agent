<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->


# SDC Networking Agent

The SDC networking agent (net-agent) keeps track of per instance NIC changes in
a data center. There is one networking agent installed in the global zone on
each compute node. NIC changes trigger updates on [NAPI](https://github.com/joyent/sdc-napi) so
data is persisted.

This repository is part of the SmartDataCenter (SDC) project. For
contribution guidelines, issues, and general documentation, visit the
[main SDC project](http://github.com/joyent/sdc).

## Development

Typically net-agent development is done by:

1. Making edits to a clone of sdc-net-agent.git on a Mac or
   a SmartOS development zone:

        git clone git@github.com:joyent/sdc-net-agent.git
        cd sdc-net-agent
        git submodule update --init
        vi

1. Building:

        make all
        make check

1. Syncing changes to a running SDC (typically CoaL):

        ./tools/rsync-to coal

1. Testing changes in that SDC (e.g. CoaL).
   See "Testing" below for running the test suite.


## Testing

At the moment, net-agent testing is done by running the [VMAPI](https://github.com/joyent/sdc-vmapi)
test suite. SSH into a running SDC and run the following commands:

	touch /lib/sdc/.sdc-test-no-production-data
	/zones/`vmadm lookup -1 alias=vmapi0`/root/opt/smartdc/vmapi/test/runtests

The net-agent SMF service log can be inspected while running the VMAPI tests by
calling:

	tail -f `svcs -L net-agent` | bunyan


## License

SDC networking agent is licensed under the
[Mozilla Public License version 2.0](http://mozilla.org/MPL/2.0/).
