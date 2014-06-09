#!/bin/bash

export SMFDIR=$npm_config_smfdir

if svcs net-agent; then
svcadm disable -s net-agent
svccfg delete net-agent
fi

rm -f "$SMFDIR/net-agent.xml"
