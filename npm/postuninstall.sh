#!/bin/bash

export SMFDIR=$npm_config_smfdir

if svcs vm-agent; then
svcadm disable -s vm-agent
svccfg delete vm-agent
fi

rm -f "$SMFDIR/vm-agent.xml"
