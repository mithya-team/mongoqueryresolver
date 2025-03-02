import Filter from './filter';
import { Db, ObjectId } from 'mongodb';
import * as _ from 'lodash';

const isFieldObject = (field: any): field is Record<string, any> => {
    if (typeof field === 'object') {
        return true;
    }
    return false;
}
const isFieldString = (field: any): field is string => {
    if (typeof field === 'string') {
        return true;
    }
    return false;
}

const validatePath = (path: string) => {
    if (!path) throw new Error(`field is required`);
    if (!path.includes('.$.') && !path.includes('.')) return;
    const first$index = path.indexOf(`.$.`);
    const firstdotindex = path.indexOf(`.`);
    const last$index = path.lastIndexOf(`.$.`);
    const lastdotindex = path.lastIndexOf(`.`);
    if (first$index === 0 || firstdotindex === 0) {
        throw new Error(`Invalid field ${path}`);
    }
    if (last$index >= 0 && lastdotindex >= 0) {
        if (last$index >= path.length - 3 || lastdotindex === path.length - 1) {
            throw new Error(`Invalid field ${path}`);
        }
    }
};

const arrayMapper = (path: string, data: { [key: string]: any }): any[] => {
    validatePath(path);

    if (path.indexOf(`.$.`) === -1) {
        return _.get(data, path);
    }
    let key = path.slice(0, path.indexOf(`.$.`));

    let values: any[] = _.get(data, key) || [];

    path = path.slice(path.indexOf(`.$.`) + 3);

    if (path) {
        let subValues: any[] = [];
        for (let value of values) {
            let subValue = arrayMapper(path, value);
            if (_.isArray(subValue)) {
                subValues.push(...subValue);
            } else {
                subValues.push(subValue);
            }
        }
        values = subValues;
    }

    return _.filter(values, (v) => v !== null && v !== undefined);
};
const fixDates = (obj: any) => {
    if (typeof obj !== 'object') {
        return typeof obj === 'string' && !isNaN(new Date(obj).getTime())
            ? new Date(obj)
            : obj;
    }

    if (obj[0] && obj.length) {
        return obj.map(fixDates);
    }
    for (let key in obj) {
        if (key !== '_id' && key !== 'id' && !key.match(/Id$/)) {
            obj[key] = fixDates(obj[key]);
        }
    }

    return obj;
};

const find = async (db: Db, filter: Filter): Promise<any[]> => {
    let collection = db.collection(filter.collection);
    let projection: { [key: string]: 1 };
    if (filter.fields) {
        for (let field of filter.fields) {
            projection = projection || {};
            if (typeof field === 'string') {
                validatePath(field);
                projection[field] = 1;
            } else if (isFieldString(field.value) && !field.value.includes('$') && !!!field.resolve) {
                validatePath(field.value);
                projection[field.value] = 1;
            } else if (isFieldString(field.value)) {
                validatePath(field.value);
            }
        }
    }

    let cursor = collection.find(fixDates(filter.where), {
        projection,
        limit: filter.limit,
        sort: filter.sort,
        skip: filter.skip,
    });

    let results = await cursor.toArray();

    if (filter.include) {
        for (let field in filter.include) {
            let relation = filter.include[field];
            for (let index = 0; index < results.length; index++) {
                let instance = results[index];
                switch (relation.relation) {
                    case 'belongsTo':
                        instance[field] = (
                            await find(db, {
                                ...relation.scope,
                                collection: relation.collection,
                                where: {
                                    [relation.primaryKey || '_id']:
                                        instance[relation.foreignKey],
                                },
                            })
                        )[0];
                        break;
                    case 'hasAndBelongsToMany':
                        let throughInstances = await find(db, {
                            ...relation.throughScope,
                            collection: relation.through,
                            where: {
                                ..._.get(relation, 'throughScope.where'),
                                [relation.foreignKey]:
                                    instance[relation.primaryKey || '_id'],
                            },
                            fields: ['_id', relation.relationKey],
                        });

                        instance[field] = await find(db, {
                            ...relation.scope,
                            collection: relation.collection,
                            where: {
                                [relation.relationPrimaryKey || '_id']: {
                                    $in: _.map(
                                        throughInstances,
                                        relation.relationKey,
                                    ),
                                },
                            },
                        });
                        break;
                    case 'hasOne':
                        instance[field] = (
                            await find(db, {
                                ...relation.scope,
                                collection: relation.collection,
                                where: {
                                    [relation.foreignKey]:
                                        instance[relation.primaryKey || '_id'],
                                },
                            })
                        )[0];
                        break;
                    case 'hasMany':
                        instance[field] = await find(db, {
                            ...relation.scope,
                            collection: relation.collection,
                            where: {
                                [relation.foreignKey]:
                                    instance[relation.primaryKey || '_id'],
                            },
                        });
                        break;
                    case 'referencesMany':
                        let foreignKeyValues = instance[relation.foreignKey];
                        if (!foreignKeyValues) {
                            foreignKeyValues = [];
                        }
                        else if (!Array.isArray(foreignKeyValues)) {
                            foreignKeyValues = [foreignKeyValues];
                        }
                        instance[field] = await find(db, {
                            ...relation.scope,
                            collection: relation.collection,
                            where: {
                                [relation.primaryKey || '_id']: {
                                    $in: foreignKeyValues
                                },
                            },
                        });
                    default:
                        break;
                }
            }
        }
    }
    if (filter.fields) {
        let formattedResults = [];
        for (let index = 0; index < results.length; index++) {
            let formattedResult: { [key: string]: any } =
                filter.includeRemainingFields ? results[index] : {};
            for (let field of filter.fields) {

                if (typeof field == 'string') {
                    formattedResult[field] = results[index][field];
                } else if (
                    !field.resolve &&
                    typeof field.resolve !== 'undefined'
                ) {
                    formattedResult[field.field] = field.value;
                } else if (isFieldString(field.value) && !field.value.includes('$')) {
                    formattedResult[field.field] = _.get(
                        results[index],
                        field.value,
                    );

                    if (field.type === 'location') {
                        const location = formattedResult[field.field] || {};
                        formattedResult[field.field] = {
                            lat: location.lat || location[0],
                            lon: location.lon || location.lng || location[1],
                        };
                    }
                }
                else if (isFieldObject(field.value) && field.value.op === 'map') {
                    if (!field.value.input || !field.value.in) {
                        break;
                    }
                    const input = field.value.input as Array<string>;
                    // Flatten input to key -> value
                    const inputMap = _.reduce(
                        input,
                        (acc, value, key) => {
                            acc[value] = results[index][value];
                            return acc;
                        },
                        {} as { [key: string]: object },
                    );
                    const mappers = field.value.in as Record<string, Record<string, any>>;
                    const resultsMap = [] as any[];
                    // This is being made for array of objects
                    for (const mapper in mappers) {
                        const mapperDefinition = mappers[mapper];
                        const toMapValues = inputMap[mapper];
                        _.map(
                            toMapValues,
                            (value) => {
                                const clonedMapperDefinition = {} as Record<string, any>;
                                const mapperKeys = Object.keys(mapperDefinition);
                                for (const key of mapperKeys) {
                                    const extractedValue = _.get(value, mapperDefinition[key])
                                    if (extractedValue) {
                                        clonedMapperDefinition[key] = _.get(value, mapperDefinition[key])
                                    }
                                }
                                resultsMap.push(clonedMapperDefinition);
                            }
                        )
                    }
                    formattedResult[field.field] = resultsMap;
                }
                else if (isFieldString(field.value)) {
                    formattedResult[field.field] = arrayMapper(
                        field.value,
                        results[index],
                    );
                    if (field.makeUnique) {
                        if (
                            formattedResult[field.field][0] instanceof ObjectId
                        ) {
                            formattedResult[field.field] = _.uniqBy(
                                formattedResult[field.field],
                                (id) => id.toString(),
                            );
                        } else if (
                            _.isObject(formattedResult[field.field][0])
                        ) {
                            formattedResult[field.field] = _.uniqBy(
                                formattedResult[field.field],
                                field.uniqBy || '_id',
                            );
                        } else {
                            formattedResult[field.field] = _.uniq(
                                formattedResult[field.field],
                            );
                        }
                    }

                    if (field.type === 'location') {
                        for (
                            let i = 0;
                            i < formattedResult[field.field].length;
                            i++
                        ) {
                            const location =
                                formattedResult[field.field][i] || {};
                            formattedResult[field.field][i] = {
                                lat: location.lat || location[0],
                                lon:
                                    location.lon || location.lng || location[1],
                            };
                        }
                    }
                }
                if (typeof field !== "string") {
                    const uniqField = field.uniqBy;
                    if (uniqField && _.isArray(formattedResult[field.field])) {
                        formattedResult[field.field] = _.uniqBy(
                            formattedResult[field.field]
                                .map((i: any) => {
                                    const stringVal = _.get(i, uniqField, '').toString();
                                    if (!stringVal) return i;
                                    _.set(i, uniqField, stringVal);
                                    return i;
                                }
                                ),
                            field.uniqBy);
                    }
                }
            }
            formattedResults.push(formattedResult);
        }
        results = formattedResults;
    }
    if (filter.exclude) {
        for (let index = 0; index < results.length; index++) {
            for (let excludeField of filter.exclude) {
                results[index] = removeField(results[index], excludeField);
            }
        }
    }

    return results;
};

const removeField = (data: { [key: string]: any }, field: string) => {
    if (typeof data !== 'object') return data;
    let _data = Object.assign({}, data);
    if (_data[field]) {
        delete _data[field];
    } else if (field.includes('.')) {
        const dotAt = field.indexOf('.');
        const key = field.slice(0, dotAt);
        if (_data[key]) {
            if (Array.isArray(_data[key])) {
                _data[key] = _.map(_data[key], (value) =>
                    removeField(value, field.slice(dotAt + 1)),
                );
            } else {
                _data[key] = removeField(_data[key], field.slice(dotAt + 1));
            }
        }
    }
    return _data;
};

export default find;
