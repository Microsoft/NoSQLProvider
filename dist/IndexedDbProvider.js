/**
 * IndexedDbProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for IndexedDB, a web browser storage module.
 */
"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var _ = require('lodash');
var SyncTasks = require('synctasks');
var NoSqlProvider = require('./NoSqlProvider');
var NoSqlProviderUtils = require('./NoSqlProviderUtils');
// The DbProvider implementation for IndexedDB.  This one is fairly straightforward since the library's access patterns pretty
// closely mirror IndexedDB's.  We mostly do a lot of wrapping of the APIs into JQuery promises and have some fancy footwork to
// do semi-automatic schema upgrades.
var IndexedDbProvider = (function (_super) {
    __extends(IndexedDbProvider, _super);
    // By default, it uses the in-browser indexed db factory, but you can pass in an explicit factory.  Currently only used for unit tests.
    function IndexedDbProvider(explicitDbFactory, explicitDbFactorySupportsCompoundKeys) {
        _super.call(this);
        if (explicitDbFactory) {
            this._dbFactory = explicitDbFactory;
            this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
        }
        else {
            this._dbFactory = window._indexedDB || window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
            // IE/Edge's IndexedDB implementation doesn't support compound keys, so we have to fake it by implementing them similar to how
            // the WebSqlProvider does, by concatenating the values into another field which then gets its own index.
            var isIE = NoSqlProviderUtils.isIE();
            if (typeof explicitDbFactorySupportsCompoundKeys !== 'undefined') {
                this._fakeComplicatedKeys = !explicitDbFactorySupportsCompoundKeys;
            }
            else {
                this._fakeComplicatedKeys = isIE;
            }
        }
    }
    IndexedDbProvider.WrapRequest = function (req) {
        var task = SyncTasks.Defer();
        req.onsuccess = function () {
            task.resolve(req.result);
        };
        req.onerror = function (ev) {
            task.reject(ev);
        };
        return task.promise();
    };
    IndexedDbProvider.prototype.open = function (dbName, schema, wipeIfExists, verbose) {
        var _this = this;
        // Note: DbProvider returns null instead of a promise that needs waiting for.
        _super.prototype.open.call(this, dbName, schema, wipeIfExists, verbose);
        if (!this._dbFactory) {
            // Couldn't even find a supported indexeddb object on the browser...
            return SyncTasks.Rejected('No support for IndexedDB in this browser');
        }
        if (!this._test && typeof (navigator) !== 'undefined' && ((navigator.userAgent.indexOf('Safari') !== -1 &&
            navigator.userAgent.indexOf('Chrome') === -1 && navigator.userAgent.indexOf('BB10') === -1) ||
            (navigator.userAgent.indexOf('Mobile Crosswalk') !== -1))) {
            // Safari doesn't support indexeddb properly, so don't let it try
            // Android crosswalk indexeddb is slow, don't use it
            return SyncTasks.Rejected('Safari doesn\'t properly implement IndexedDB');
        }
        if (wipeIfExists) {
            try {
                this._dbFactory.deleteDatabase(dbName);
            }
            catch (e) {
            }
        }
        var dbOpen = this._dbFactory.open(dbName, schema.version);
        var migrationPutters = [];
        dbOpen.onupgradeneeded = function (event) {
            var db = dbOpen.result;
            var target = (event.currentTarget || event.target);
            if (schema.lastUsableVersion && event.oldVersion < schema.lastUsableVersion) {
                // Clear all stores if it's past the usable version
                console.log('Old version detected (' + event.oldVersion + '), clearing all data');
                _.each(db.objectStoreNames, function (name) {
                    db.deleteObjectStore(name);
                });
            }
            // Delete dead stores
            _.each(db.objectStoreNames, function (storeName) {
                if (!_.some(schema.stores, function (store) { return store.name === storeName; })) {
                    db.deleteObjectStore(storeName);
                }
            });
            // Create all stores
            _.each(schema.stores, function (storeSchema) {
                var store = null;
                var migrateData = false;
                if (!_.includes(db.objectStoreNames, storeSchema.name)) {
                    var primaryKeyPath = storeSchema.primaryKeyPath;
                    if (_this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(primaryKeyPath)) {
                        // Going to have to hack the compound primary key index into a column, so here it is.
                        primaryKeyPath = 'nsp_pk';
                    }
                    // Any is to fix a lib.d.ts issue in TS 2.0.3 - it doesn't realize that keypaths can be compound for some reason...
                    store = db.createObjectStore(storeSchema.name, { keyPath: primaryKeyPath });
                }
                else {
                    store = target.transaction.objectStore(storeSchema.name);
                    migrateData = true;
                    // Check for any indexes no longer in the schema or have been changed
                    _.each(store.indexNames, function (indexName) {
                        var index = store.index(indexName);
                        var nuke = false;
                        var indexSchema = _.find(storeSchema.indexes, function (idx) { return idx.name === indexName; });
                        if (!_.isObject(indexSchema)) {
                            nuke = true;
                        }
                        else if (typeof index.keyPath !== typeof indexSchema.keyPath) {
                            nuke = true;
                        }
                        else if (typeof index.keyPath === 'string') {
                            if (index.keyPath !== indexSchema.keyPath) {
                                nuke = true;
                            }
                        }
                        else if (index.keyPath.length !== indexSchema.keyPath.length) {
                            // Keypath length doesn't match, don't bother doing a comparison of each element
                            nuke = true;
                        }
                        else {
                            for (var i = 0; i < index.keyPath.length; i++) {
                                if (index.keyPath[i] !== indexSchema.keyPath[i]) {
                                    nuke = true;
                                    break;
                                }
                            }
                        }
                        if (nuke) {
                            store.deleteIndex(indexName);
                        }
                    });
                }
                // Check any indexes in the schema that need to be created
                _.each(storeSchema.indexes, function (indexSchema) {
                    if (!_.includes(store.indexNames, indexSchema.name)) {
                        var keyPath = indexSchema.keyPath;
                        if (_this._fakeComplicatedKeys) {
                            if (indexSchema.multiEntry) {
                                if (NoSqlProviderUtils.isCompoundKeyPath(keyPath)) {
                                    throw new Error('Can\'t use multiEntry and compound keys');
                                }
                                else {
                                    // Create an object store for the index
                                    var indexStore_1 = db.createObjectStore(storeSchema.name + '_' + indexSchema.name, { keyPath: 'key' });
                                    indexStore_1.createIndex('key', 'key');
                                    indexStore_1.createIndex('refkey', 'refkey');
                                    if (migrateData) {
                                        // Walk every element in the store and re-put it to fill out the new index.
                                        var cursorReq = store.openCursor();
                                        var thisIndexPutters_1 = [];
                                        migrationPutters.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, function (cursor) {
                                            var item = cursor.value;
                                            // Get each value of the multientry and put it into the index store
                                            var valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, indexSchema.keyPath);
                                            // It might be an array of multiple entries, so just always go with array-based logic
                                            var vals = NoSqlProviderUtils.arrayify(valsRaw);
                                            var refKey = NoSqlProviderUtils.getSerializedKeyForKeypath(item, storeSchema.primaryKeyPath);
                                            // After nuking the existing entries, add the new ones
                                            _.each(vals, function (val) {
                                                var indexObj = {
                                                    key: val,
                                                    refkey: refKey
                                                };
                                                thisIndexPutters_1.push(IndexedDbProvider.WrapRequest(indexStore_1.put(indexObj)));
                                            });
                                        }).then(function () { return SyncTasks.all(thisIndexPutters_1).then(function () { return void 0; }); }));
                                    }
                                }
                            }
                            else if (NoSqlProviderUtils.isCompoundKeyPath(keyPath)) {
                                // Going to have to hack the compound index into a column, so here it is.
                                store.createIndex(indexSchema.name, 'nsp_i_' + indexSchema.name, {
                                    unique: indexSchema.unique
                                });
                            }
                            else {
                                store.createIndex(indexSchema.name, keyPath, {
                                    unique: indexSchema.unique
                                });
                            }
                        }
                        else {
                            store.createIndex(indexSchema.name, keyPath, {
                                unique: indexSchema.unique,
                                multiEntry: indexSchema.multiEntry
                            });
                        }
                    }
                });
            });
        };
        var promise = IndexedDbProvider.WrapRequest(dbOpen);
        return promise.then(function (db) {
            return SyncTasks.all(migrationPutters).then(function () {
                _this._db = db;
            });
        }, function (err) {
            if (err && err.type === 'error' && err.target && err.target.error && err.target.error.name === 'VersionError') {
                if (!wipeIfExists) {
                    console.log('Database version too new, Wiping: ' + (err.target.error.message || err.target.error.name));
                    return _this.open(dbName, schema, true, verbose);
                }
            }
            return SyncTasks.Rejected(err);
        });
    };
    IndexedDbProvider.prototype.close = function () {
        this._db.close();
        this._db = null;
        return SyncTasks.Resolved();
    };
    IndexedDbProvider.prototype.openTransaction = function (storeNames, writeNeeded) {
        var _this = this;
        // Clone the list becuase we're going to add fake store names to it
        var intStoreNames = NoSqlProviderUtils.arrayify(_.clone(storeNames));
        if (this._fakeComplicatedKeys) {
            // Pull the alternate multientry stores into the transaction as well
            var missingStores_1 = [];
            _.each(intStoreNames, function (storeName) {
                var storeSchema = _.find(_this._schema.stores, function (s) { return s.name === storeName; });
                if (!storeSchema) {
                    missingStores_1.push(storeName);
                    return;
                }
                if (storeSchema.indexes) {
                    _.each(storeSchema.indexes, function (indexSchema) {
                        if (indexSchema.multiEntry) {
                            intStoreNames.push(storeSchema.name + '_' + indexSchema.name);
                        }
                    });
                }
            });
            if (missingStores_1.length > 0) {
                return SyncTasks.Rejected('Can\'t find store(s): ' + missingStores_1.join(','));
            }
        }
        try {
            var trans = this._db.transaction(intStoreNames, writeNeeded ? 'readwrite' : 'readonly');
            var ourTrans = new IndexedDbTransaction(trans, this._schema, intStoreNames, this._fakeComplicatedKeys);
            return SyncTasks.Resolved(ourTrans);
        }
        catch (e) {
            return SyncTasks.Rejected(e);
        }
    };
    return IndexedDbProvider;
}(NoSqlProvider.DbProvider));
exports.IndexedDbProvider = IndexedDbProvider;
// DbTransaction implementation for the IndexedDB DbProvider.
var IndexedDbTransaction = (function () {
    function IndexedDbTransaction(trans, schema, storeNames, fakeComplicatedKeys) {
        var _this = this;
        this._trans = trans;
        this._schema = schema;
        this._fakeComplicatedKeys = fakeComplicatedKeys;
        this._stores = _.map(storeNames, function (storeName) { return _this._trans.objectStore(storeName); });
    }
    IndexedDbTransaction.prototype.getStore = function (storeName) {
        var _this = this;
        var store = _.find(this._stores, function (s) { return s.name === storeName; });
        var storeSchema = _.find(this._schema.stores, function (s) { return s.name === storeName; });
        if (store === void 0 || storeSchema === void 0) {
            return null;
        }
        var indexStores = [];
        if (this._fakeComplicatedKeys && storeSchema.indexes) {
            // Pull the alternate multientry stores in as well
            _.each(storeSchema.indexes, function (indexSchema) {
                if (indexSchema.multiEntry) {
                    indexStores.push(_this._trans.objectStore(storeSchema.name + '_' + indexSchema.name));
                }
            });
        }
        return new IndexedDbStore(store, indexStores, storeSchema, this._fakeComplicatedKeys);
    };
    return IndexedDbTransaction;
}());
// DbStore implementation for the IndexedDB DbProvider.  Again, fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE.
var IndexedDbStore = (function () {
    function IndexedDbStore(store, indexStores, schema, fakeComplicatedKeys) {
        this._store = store;
        this._indexStores = indexStores;
        this._schema = schema;
        this._fakeComplicatedKeys = fakeComplicatedKeys;
    }
    IndexedDbStore.prototype.get = function (key) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            key = NoSqlProviderUtils.serializeKeyToString(key, this._schema.primaryKeyPath);
        }
        return IndexedDbProvider.WrapRequest(this._store.get(key));
    };
    IndexedDbStore.prototype.getMultiple = function (keyOrKeys) {
        var _this = this;
        var keys = NoSqlProviderUtils.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            keys = _.map(keys, function (key) { return NoSqlProviderUtils.serializeKeyToString(key, _this._schema.primaryKeyPath); });
        }
        // There isn't a more optimized way to do this with indexeddb, have to get the results one by one
        return SyncTasks.all(_.map(keys, function (key) { return IndexedDbProvider.WrapRequest(_this._store.get(key)); }));
    };
    IndexedDbStore.prototype.put = function (itemOrItems) {
        var _this = this;
        var items = NoSqlProviderUtils.arrayify(itemOrItems);
        var promises = [];
        _.each(items, function (item) {
            if (_this._fakeComplicatedKeys) {
                // Fill out any compound-key indexes
                if (NoSqlProviderUtils.isCompoundKeyPath(_this._schema.primaryKeyPath)) {
                    item['nsp_pk'] = NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath);
                }
                _.each(_this._schema.indexes, function (index) {
                    if (index.multiEntry) {
                        var indexStore_2 = _.find(_this._indexStores, function (store) { return store.name === _this._schema.name + '_' + index.name; });
                        // Get each value of the multientry and put it into the index store
                        var valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, index.keyPath);
                        // It might be an array of multiple entries, so just always go with array-based logic
                        var valsArray = NoSqlProviderUtils.arrayify(valsRaw);
                        var keys_1 = valsArray;
                        // We're using normal indexeddb tables to store the multientry indexes, so we only need to use the key
                        // serialization if the multientry keys ALSO are compound.
                        if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                            keys_1 = _.map(keys_1, function (val) { return NoSqlProviderUtils.serializeKeyToString(val, index.keyPath); });
                        }
                        // We need to reference the PK of the actual row we're using here, so calculate the actual PK -- if it's 
                        // compound, we're already faking complicated keys, so we know to serialize it to a string.  If not, use the
                        // raw value.
                        var refKey_1 = NoSqlProviderUtils.getKeyForKeypath(item, _this._schema.primaryKeyPath);
                        if (_.isArray(_this._schema.primaryKeyPath)) {
                            refKey_1 = NoSqlProviderUtils.serializeKeyToString(refKey_1, _this._schema.primaryKeyPath);
                        }
                        // First clear out the old values from the index store for the refkey
                        var cursorReq = indexStore_2.index('refkey').openCursor(IDBKeyRange.only(refKey_1));
                        promises.push(IndexedDbIndex.iterateOverCursorRequest(cursorReq, function (cursor) {
                            cursor['delete']();
                        })
                            .then(function () {
                            // After nuking the existing entries, add the new ones
                            var iputters = _.map(keys_1, function (key) {
                                var indexObj = {
                                    key: key,
                                    refkey: refKey_1
                                };
                                return IndexedDbProvider.WrapRequest(indexStore_2.put(indexObj));
                            });
                            return SyncTasks.all(iputters);
                        }).then(function (rets) { return void 0; }));
                    }
                    else if (NoSqlProviderUtils.isCompoundKeyPath(index.keyPath)) {
                        item['nsp_i_' + index.name] = NoSqlProviderUtils.getSerializedKeyForKeypath(item, index.keyPath);
                    }
                });
            }
            var promise;
            try {
                promise = IndexedDbProvider.WrapRequest(_this._store.put(item));
            }
            catch (e) {
                promise = SyncTasks.Rejected(e);
            }
            promises.push(promise);
        });
        return SyncTasks.all(promises).then(function (rets) { return void 0; });
    };
    IndexedDbStore.prototype.remove = function (keyOrKeys) {
        var _this = this;
        var keys = NoSqlProviderUtils.formListOfKeys(keyOrKeys, this._schema.primaryKeyPath);
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._schema.primaryKeyPath)) {
            keys = _.map(keys, function (key) { return NoSqlProviderUtils.serializeKeyToString(key, _this._schema.primaryKeyPath); });
        }
        return SyncTasks.all(_.map(keys, function (key) {
            if (_this._fakeComplicatedKeys && _.some(_this._schema.indexes, function (index) { return index.multiEntry; })) {
                // If we're faking keys and there's any multientry indexes, we have to do the way more complicated version...
                return IndexedDbProvider.WrapRequest(_this._store.get(key)).then(function (item) {
                    if (item) {
                        // Go through each multiEntry index and nuke the referenced items from the sub-stores
                        var promises = _.map(_.filter(_this._schema.indexes, function (index) { return index.multiEntry; }), function (index) {
                            var indexStore = _.find(_this._indexStores, function (store) { return store.name === _this._schema.name + '_' + index.name; });
                            var refKey = NoSqlProviderUtils.getSerializedKeyForKeypath(item, _this._schema.primaryKeyPath);
                            // First clear out the old values from the index store for the refkey
                            var cursorReq = indexStore.index('refkey').openCursor(IDBKeyRange.only(refKey));
                            return IndexedDbIndex.iterateOverCursorRequest(cursorReq, function (cursor) {
                                cursor['delete']();
                            });
                        });
                        // Also remember to nuke the item from the actual store
                        promises.push(IndexedDbProvider.WrapRequest(_this._store['delete'](key)));
                        return SyncTasks.all(promises).then(_.noop);
                    }
                });
            }
            return IndexedDbProvider.WrapRequest(_this._store['delete'](key));
        })).then(function (rets) { return void 0; });
    };
    IndexedDbStore.prototype.openIndex = function (indexName) {
        var _this = this;
        var indexSchema = _.find(this._schema.indexes, function (idx) { return idx.name === indexName; });
        if (indexSchema === void 0) {
            return null;
        }
        if (this._fakeComplicatedKeys && indexSchema.multiEntry) {
            var store = _.find(this._indexStores, function (indexStore) { return indexStore.name === _this._schema.name + '_' + indexSchema.name; });
            if (store === void 0) {
                return null;
            }
            return new IndexedDbIndex(store.index('key'), indexSchema.keyPath, this._fakeComplicatedKeys, this._store);
        }
        else {
            var index = this._store.index(indexName);
            if (index === void 0) {
                return null;
            }
            return new IndexedDbIndex(index, indexSchema.keyPath, this._fakeComplicatedKeys);
        }
    };
    IndexedDbStore.prototype.openPrimaryKey = function () {
        return new IndexedDbIndex(this._store, this._schema.primaryKeyPath, this._fakeComplicatedKeys);
    };
    IndexedDbStore.prototype.clearAllData = function () {
        var storesToClear = [this._store];
        if (this._indexStores) {
            storesToClear = storesToClear.concat(this._indexStores);
        }
        var promises = _.map(storesToClear, function (store) { return IndexedDbProvider.WrapRequest(store.clear()); });
        return SyncTasks.all(promises).then(function (rets) { return void 0; });
    };
    return IndexedDbStore;
}());
// DbIndex implementation for the IndexedDB DbProvider.  Fairly closely maps to the standard IndexedDB spec, aside from
// a bunch of hacks to support compound keypaths on IE and some helpers to make the caller not have to walk the awkward cursor
// result APIs to get their result list.  Also added ability to use an "index" for opening the primary key on a store.
var IndexedDbIndex = (function () {
    function IndexedDbIndex(store, keyPath, fakeComplicatedKeys, fakedOriginalStore) {
        this._store = store;
        this._keyPath = keyPath;
        this._fakeComplicatedKeys = fakeComplicatedKeys;
        this._fakedOriginalStore = fakedOriginalStore;
    }
    IndexedDbIndex.prototype._resolveCursorResult = function (req, limit, offset) {
        var _this = this;
        if (this._fakeComplicatedKeys && this._fakedOriginalStore) {
            // Get based on the keys from the index store, which have refkeys that point back to the original store
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset).then(function (rets) {
                // Now get the original items using the refkeys from the index store, which are PKs on the main store
                var getters = _.map(rets, function (ret) { return IndexedDbProvider.WrapRequest(_this._fakedOriginalStore.get(ret.refkey)); });
                return SyncTasks.all(getters);
            });
        }
        else {
            return IndexedDbIndex.getFromCursorRequest(req, limit, offset);
        }
    };
    IndexedDbIndex.prototype.getAll = function (reverse, limit, offset) {
        var req = this._store.openCursor(null, reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    };
    IndexedDbIndex.prototype.getOnly = function (key, reverse, limit, offset) {
        var req = this._store.openCursor(this._getKeyRangeForOnly(key), reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    };
    IndexedDbIndex.prototype._getKeyRangeForOnly = function (key) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._keyPath)) {
            return IDBKeyRange.only(NoSqlProviderUtils.serializeKeyToString(key, this._keyPath));
        }
        return IDBKeyRange.only(key);
    };
    IndexedDbIndex.prototype.getRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive, reverse, limit, offset) {
        var req = this._store.openCursor(this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive), reverse ? 'prev' : 'next');
        return this._resolveCursorResult(req, limit, offset);
    };
    IndexedDbIndex.prototype._getKeyRangeForRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        if (this._fakeComplicatedKeys && NoSqlProviderUtils.isCompoundKeyPath(this._keyPath)) {
            // IE has to switch to hacky pre-joined-compound-keys
            return IDBKeyRange.bound(NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath), NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath), lowRangeExclusive, highRangeExclusive);
        }
        return IDBKeyRange.bound(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
    };
    IndexedDbIndex.prototype.countAll = function () {
        var req = this._store.count(null);
        return this._countRequest(req);
    };
    IndexedDbIndex.prototype.countOnly = function (key) {
        var req = this._store.count(this._getKeyRangeForOnly(key));
        return this._countRequest(req);
    };
    IndexedDbIndex.prototype.countRange = function (keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive) {
        var req = this._store.count(this._getKeyRangeForRange(keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive));
        return this._countRequest(req);
    };
    IndexedDbIndex.getFromCursorRequest = function (req, limit, offset) {
        var outList = [];
        return this.iterateOverCursorRequest(req, function (cursor) {
            outList.push(cursor.value);
        }, limit, offset).then(function () {
            return outList;
        });
    };
    IndexedDbIndex.prototype._countRequest = function (req) {
        var deferred = SyncTasks.Defer();
        req.onsuccess = function (event) {
            deferred.resolve(event.target.result);
        };
        req.onerror = function (ev) {
            deferred.reject(ev);
        };
        return deferred.promise();
    };
    IndexedDbIndex.iterateOverCursorRequest = function (req, func, limit, offset) {
        var deferred = SyncTasks.Defer();
        var count = 0;
        req.onsuccess = function (event) {
            var cursor = event.target.result;
            if (cursor) {
                if (offset) {
                    cursor.advance(offset);
                    offset = 0;
                }
                else {
                    func(cursor);
                    count++;
                    if (limit && (count === limit)) {
                        deferred.resolve();
                        return;
                    }
                    cursor['continue']();
                }
            }
            else {
                // Nothing else to iterate
                deferred.resolve();
            }
        };
        req.onerror = function (ev) {
            deferred.reject(ev);
        };
        return deferred.promise();
    };
    return IndexedDbIndex;
}());
