<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2016, Joyent, Inc.
-->


# sdc-net-agent

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

The SDC Networking agent is a library for keeping track of per VM NIC changes on
a Triton data center. There is one Networking agent installed per Compute Node.
NIC changes trigger updates on [NAPI](https://github.com/joyent/sdc-napi) so
data is persisted.

# Development

Typically sdc-net-agent development is done by:

- making edits to a clone of sdc-net-agent.git on a Mac (likely Linux too, but
  that's untested) or a SmartOS development zone,

        git clone git@github.com:joyent/sdc-net-agent.git
        cd sdc-net-agent
        git submodule update --init   # not necessary first time
        vi

- building:

        make all
        make check

- syncing changes to a running SDC (typically a COAL running locally in VMWare)
  via:
        ./tools/rsync-to coal

- then testing changes in that SDC (e.g. COAL).
  See "Testing" below for running the test suite.


## Testing

At the moment, sdc-net-agent testing is done by running the VMAPI test suite.
SSH into a running SDC and run the following commands:

	touch /lib/sdc/.sdc-test-no-production-data
	/zones/`vmadm lookup -1 alias=vmapi0`/root/opt/smartdc/vmapi/test/runtests

The net-agent SMF service log can be inspected while running the VMAPI tests by
calling:

	tail -f `svcs -L net-agent` | bunyan

