﻿ /**
 * FullTextSearchHelpers.ts
 * Author: David de Regt
 * Copyright: Microsoft 2017
 *
 * Reusable helper classes and functions for supporting Full Text Search.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');

export function breakAndNormalizeSearchPhrase(phrase: string): string[] {
    // Faster than using _.uniq since it's just a pile of strings.
    // Deburr and tolower before using _.words since _.words breaks on CaseChanges.
    return _.keys(_.mapKeys(_.words(_.deburr(phrase).toLowerCase())));
}

export function getFullTextIndexWordsForItem(keyPath: string, item: any): string[] {
    const rawString = NoSqlProviderUtils.getValueForSingleKeypath(item, keyPath);

    return breakAndNormalizeSearchPhrase(rawString);
}

export abstract class DbIndexFTSFromRangeQueries implements NoSqlProvider.DbIndex {
    protected _keyPath: string | string[];

    constructor(protected _indexSchema: NoSqlProvider.IndexSchema, protected _primaryKeyPath: string | string[]) {
        this._keyPath = this._indexSchema ? this._indexSchema.keyPath : this._primaryKeyPath;
    }

    fullTextSearch<T>(searchPhrase: string, resolution: NoSqlProvider.FullTextTermResolution = NoSqlProvider.FullTextTermResolution.And)
            : SyncTasks.Promise<T[]> {
        if (!this._indexSchema.fullText) {
            return SyncTasks.Rejected<T[]>('fullTextSearch performed against non-fullText index!');
        }

        const terms = breakAndNormalizeSearchPhrase(searchPhrase);
        if (terms.length === 0) {
            return SyncTasks.Rejected<T[]>('fullTextSearch called with empty searchPhrase');
        }

        const promises = _.map(terms, term => {
            const upperEnd = term.substr(0, term.length - 1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
            return this.getRange<T>(term, upperEnd, false, true);
        });
        return SyncTasks.all(promises).then(results => {
            const uniquers: _.Dictionary<T>[] = _.map(results, resultSet => _.keyBy(resultSet, item =>
                NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._primaryKeyPath)));
            
            if (resolution === NoSqlProvider.FullTextTermResolution.Or) {
                return _.values(_.assign<_.Dictionary<T>>({}, ...uniquers));
            }

            if (resolution === NoSqlProvider.FullTextTermResolution.And) {
                const [first, ...others] = uniquers;
                return _.values(_.pickBy<_.Dictionary<T>, _.Dictionary<T>>(first, (value, key) => _.every(others, set => set[key])));
            }

            return SyncTasks.Rejected<T[]>('Undefined full text term resolution type');
        });
    }

    abstract getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    abstract getOnly<T>(key: any|any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    abstract getRange<T>(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]>;
    abstract countAll(): SyncTasks.Promise<number>;
    abstract countOnly(key: any|any[]): SyncTasks.Promise<number>;
    abstract countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : SyncTasks.Promise<number>;
}
