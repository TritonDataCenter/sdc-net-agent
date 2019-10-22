#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Files
#
JS_FILES :=		$(shell ls *.js 2>/dev/null) \
			$(shell find bin lib test -name '*.js' 2>/dev/null)
JSL_CONF_NODE =		tools/jsl.node.conf
JSL_FILES_NODE =	$(JS_FILES)
JSSTYLE_FILES =		$(JS_FILES)
JSSTYLE_FLAGS =		-o indent=4,doxygen,unparenthesized-return=0
ESLINT_FILES =		$(JS_FILES)


ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_VERSION =	v4.6.1
	NODE_PREBUILT_TAG =	gz
	# sdc-minimal-multiarch-lts 15.4.1
	NODE_PREBUILT_IMAGE =	18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

# Included definitions
ENGBLD_REQUIRE := $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
else
	NODE := node
	NPM := $(shell which npm)
	NPM_EXEC= $(NPM)
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

NAME :=			net-agent
RELEASE_TARBALL :=	$(NAME)-$(STAMP).tgz
RELEASE_MANIFEST :=	$(NAME)-$(STAMP).manifest
RELSTAGEDIR :=		/tmp/$(NAME)-$(STAMP)
TAPE =			$(TOP)/node_modules/.bin/tape

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.  These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
NPM_ENV =		SDC_AGENT_SKIP_LIFECYCLE=yes
RUN_NPM_INSTALL =	$(NPM_ENV) $(NPM) install

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS)
	$(RUN_NPM_INSTALL)

$(TAPE): | $(NPM_EXEC)
	$(RUN_NPM_INSTALL)

CLEAN_FILES += $(TAP) ./node_modules/tap

.PHONY: test
test: $(TAPE)
	$(NODE) $(TAPE) test/unit/*.test.js

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/$(NAME)
	cd $(TOP) && $(RUN_NPM_INSTALL)
	cp -r \
	    $(TOP)/bin \
	    $(TOP)/lib \
	    $(TOP)/Makefile \
	    $(TOP)/node_modules \
	    $(TOP)/package.json \
	    $(TOP)/sapi_manifests \
	    $(TOP)/smf \
	    $(TOP)/test \
	    $(TOP)/npm \
	    $(RELSTAGEDIR)/$(NAME)
	cp -PR $(NODE_INSTALL) $(RELSTAGEDIR)/$(NAME)/node
	uuid -v4 > $(RELSTAGEDIR)/$(NAME)/image_uuid
	cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(TOP)/$(RELEASE_TARBALL) *
	cat $(TOP)/manifest.tmpl | sed \
	    -e "s/UUID/$$(cat $(RELSTAGEDIR)/$(NAME)/image_uuid)/" \
	    -e "s/NAME/$$(json name < $(TOP)/package.json)/" \
	    -e "s/VERSION/$$(json version < $(TOP)/package.json)/" \
	    -e "s/DESCRIPTION/$$(json description < $(TOP)/package.json)/" \
	    -e "s/BUILDSTAMP/$(STAMP)/" \
	    -e "s/SIZE/$$(stat --printf="%s" $(TOP)/$(RELEASE_TARBALL))/" \
	    -e "s/SHA/$$(openssl sha1 $(TOP)/$(RELEASE_TARBALL) \
	    | cut -d ' ' -f2)/" \
	    > $(TOP)/$(RELEASE_MANIFEST)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)
	cp $(TOP)/$(RELEASE_MANIFEST) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_MANIFEST)

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

# Here "cutting a release" is just tagging the current commit with
# "v(package.json version)". We don't publish this to npm.
.PHONY: cutarelease
cutarelease:
	@echo "# Ensure working copy is clean."
	[[ -z `git status --short` ]]  # If this fails, the working dir is dirty.
	@echo "# Ensure have 'json' tool."
	which json 2>/dev/null 1>/dev/null
	ver=$(shell cat package.json | json version) && \
	    git tag "v$$ver" && \
	    git push origin "v$$ver"

include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
else
include ./deps/eng/tools/mk/Makefile.node.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
