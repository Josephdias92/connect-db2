/*!
 * Connect - DB2
 * Copyright(c) 2015 Ali Lokhandwala <ali@huestones.co.uk>
 * MIT Licensed
 */

'use strict';

var assert = require('assert');
var debug = require('debug')('connect:db2');
var ibmdb = require('ibm_db');
var util = require('util');
var extend = require('extend');
var noop = function () {};

/**
 * One day in seconds.
 */

var oneDay = 86400;

/**
 * Default options
 */

var defaultOptions = {
    expiration: oneDay * 30, // The maximum age of a valid session; milliseconds.
    schema: {
        tableName: 'sessions',
        columnNames: {
            session_id: 'session_id',
            expires: 'expires',
            data: 'data'
        }
    },
    allowDrop: false
};

/**
 * Work out the session expiration time
 * @param {Object} sess express session
 * @param {number} expiration the maximum age of a valid session; milliseconds.
 * @returns expiration value in seconds
 */

var getExpires = function (sess, expiration) {
    var expires;

    if (sess.cookie) {
        if (sess.cookie.expires) {
            expires = sess.cookie.expires;
        } else if (sess.cookie._expires) {
            expires = sess.cookie._expires;
        }
    }

    if (!expires) {
        expires = Date.now() + expiration;
    }

    if (!(expires instanceof Date)) {
        expires = new Date(expires);
    }

    // Use whole seconds here; not milliseconds.
    expires = Math.round(expires.getTime() / 1000);

    return expires;
};

/**
 * Return the `Db2Store` extending `express`'s session Store.
 *
 * @param {Object} express session
 * @returns {Function}
 * @api public
 */

module.exports = function (session) {

    /**
     * Express's session Store.
     */

    var Store = session.Store;

    /**
     * Initialize Db2Store with the given `options`.
     *
     * @param {Object} options
     * @api public
     */

    var Db2Store = function (options, connection) {
        if (!(this instanceof Db2Store)) {
            throw new TypeError('Cannot call Db2Store constructor as a function');
        }

        var self = this;

        this.options = extend(true, {}, defaultOptions, options || {});

        Store.call(this, this.options);

        if (connection) {
            debug('Using supplied connection, connected: %s', connection.connected);
            this.client = connection;
        } else {
            var dsn = this.options.dsn ||
                'DRIVER={DB2};DATABASE=' + this.options.database +
                ';UID=' + this.options.user +
                ';PWD=' + this.options.password +
                ';HOSTNAME=' + this.options.host +
                ';port=' + this.options.port +
                ';PROTOCOL=TCPIP';

            try {
                self.client = ibmdb.openSync(dsn);
                self.emit('connect');
            } catch (err) {
                debug('dashDB returned err', err);
                self.emit('disconnect', err);
            }
        }

        assert(this.client);
        assert(this.client.connected);
    };

    /**
     * Inherit from `Store`.
     */

    util.inherits(Db2Store, Store);

    /**
     * Attempt to fetch session by the given `sid`.
     *
     * @param {String} sid
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.get = function (sid, fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Getting session "%s"', sid);

        var sql = util.format('SELECT "%s" AS "data" FROM "%s" WHERE "%s" = ?',
            store.options.schema.columnNames.data,
            store.options.schema.tableName,
            store.options.schema.columnNames.session_id);

        assert(store.client.connected);
        store.client.query(sql, [sid], function (err, rows) {

            if (err) {
                debug('Failed to get session.');
                debug(err);
                return fn(err, null);
            }

            var result;
            try {
                result = !!rows[0] ? JSON.parse(rows[0].data) : null;

                if (result) debug('Got session "%s"', sid);
            } catch (error) {
                debug(error);
                return fn(new Error('Failed to parse data for session: ' + sid));
            }

            return fn(null, result);
        });
    };

    /**
     * Commit the given `sess` object associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.set = function (sid, sess, fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Setting session "%s"', sid);

        var expires = getExpires(sess, store.options.expiration);

        var jsess;
        try {
            jsess = JSON.stringify(sess);
        } catch (err) {
            debug(err);
            return fn(err);
        }

        var sql = util.format('SELECT COUNT(*) AS "length" FROM "%s" WHERE "%s" = ?',
            store.options.schema.tableName,
            store.options.schema.columnNames.session_id);

        assert(store.client.connected);
        store.client.query(sql, [sid], function (err, rows) {
            if (err) {
                debug('Failed to determine if session "%s" already exists', sid);
                debug(err);
                return fn(err);
            }

            var count = !!rows[0] ? rows[0].length : 0;
            var params = [];
            if (count > 0) {
                sql = util.format('UPDATE "%s" SET "%s" = ?, "%s" = ? WHERE "%s" = ?',
                    store.options.schema.tableName,
                    store.options.schema.columnNames.expires,
                    store.options.schema.columnNames.data,
                    store.options.schema.columnNames.session_id);

                params = [expires, jsess, sid];

                debug('Session "%s" already exists, will update it', sid);
            } else {
                sql = util.format('INSERT INTO "%s" ("%s", "%s", "%s") VALUES (?, ?, ?)',
                    store.options.schema.tableName,
                    store.options.schema.columnNames.session_id,
                    store.options.schema.columnNames.expires,
                    store.options.schema.columnNames.data);

                params = [sid, expires, jsess];

                debug('Session "%s" will be inserted', sid);
            }

            store.client.query(sql, params, function (err) {
                if (err) {
                    debug('Insert/Update failed for session "%s"', sid);
                    debug(err);
                    return fn(err);
                }

                return fn();
            });
        });
    };

    /**
     * Destroy the session associated with the given `sid`.
     *
     * @param {String} sid
     * @api public
     */

    Db2Store.prototype.destroy = function (sid, fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Destroying session "%s"', sid);

        var sql = util.format('DELETE FROM "%s" WHERE "%s" = ?',
            store.options.schema.tableName,
            store.options.schema.columnNames.session_id);

        assert(store.client.connected);
        store.client.query(sql, [sid], function (err) {
            if (err) {
                debug('Failed to destroy session data.');
                debug(err);
                return fn(err);
            }

            return fn();
        });
    };

    /**
     * Refresh the time-to-live for the session with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.touch = function (sid, sess, fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Touching session "%s"', sid);

        var expires = getExpires(sess, store.options.expiration);

        debug('Expire "%s" on:%s', sid, expires);

        var sql = util.format('UPDATE "%s" SET "%s" = ? WHERE "%s" = ?',
            store.options.schema.tableName,
            store.options.schema.columnNames.expires,
            store.options.schema.columnNames.session_id);

        assert(store.client.connected);
        store.client.query(sql, [expires, sid], function (err) {
            if (err) {
                debug('Failed to touch session.');
                debug(err);
                return fn(err);
            }

            return fn();
        });
    };

    /**
     * Get the count of all sessions in the store.
     *
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.length = function (fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Getting number of sessions');

        var sql = util.format('SELECT COUNT(*) AS "length" FROM "%s"', store.options.schema.tableName);

        assert(store.client.connected);
        store.client.query(sql, function (err, rows) {

            if (err) {
                debug('Failed to get number of sessions.');
                debug(err);
                return fn(err);
            }

            var count = !!rows[0] ? rows[0]['length'] : 0;

            fn(null, count);
        });
    };

    /**
     * Delete all sessions from the store.
     *
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.clear = function (fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Clearing all sessions');

        var sql = util.format('DELETE FROM "%s"', store.options.schema.tableName);

        assert(store.client.connected);
        store.client.query(sql, function (err) {
            if (err) {
                debug('Failed to clear all sessions.');
                debug(err);
                return fn(err);
            }

            fn();
        });
    };

    /**
     * Close the underlying database connection.
     *
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.close = function (fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Closing session store');

        if (!store.client) {
            return fn();
        }

        if (!store.client.connected) {
            return fn();
        }

        store.client.close(function (err) {
            if (err) {
                debug(err);
                store.emit('disconnect', err);
                return fn(err);
            }

            store.emit('disconnect', null);
            return fn();
        });

    };

    /**
     * Create the table used to store sessions.
     *
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.createDatabaseTable = function (fn) {
        var store = this;
        if (!fn) fn = noop;

        debug('Creating table %s', store.options.schema.tableName);

        var sql = util.format('CREATE TABLE "%s" ("%s" VARCHAR(255) NOT NULL PRIMARY KEY, "%s" BIGINT NOT NULL, "%s" VARCHAR(8100))',
            store.options.schema.tableName,
            store.options.schema.columnNames.session_id,
            store.options.schema.columnNames.expires,
            store.options.schema.columnNames.data
        );

        assert(store.client.connected);
        store.client.query(sql, function (err) {

            if (err) {
                debug('Failed to create session table.');
                debug(err);
                return fn(err);
            }

            fn();
        });
    };

    /**
     * Drop the table used to store sessions.
     *
     * @param {Function} fn
     * @api public
     */

    Db2Store.prototype.dropDatabaseTable = function (fn) {
        var store = this;
        if (!fn) fn = noop;

        if (!store.options.allowDrop) {
            var err = new Error('Dropping session table not allowed by config. ' +
                'Set allowDrop: true in your config to enable this.');
            debug(err);
            return fn(err);
        }

        debug('Dropping table %s', store.options.schema.tableName);

        var sql = util.format('DROP TABLE "%s"', store.options.schema.tableName);

        assert(store.client.connected);
        store.client.query(sql, function (err) {

            if (err) {
                debug('Failed to drop session table.');
                debug(err);
                return fn(err);
            }

            fn();
        });
    };

    return Db2Store;
};