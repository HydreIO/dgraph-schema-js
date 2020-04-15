import diff from 'deep-diff';
import dgraph from 'dgraph-js';
import grpc from 'grpc';

import { SCHEMA, TYPES } from './schema';

const prepare_value_string = predicate => {
  const PREPARED_ARRAY = predicate.split(' ');
  if (PREPARED_ARRAY[PREPARED_ARRAY.length - 1] === '.') {
    PREPARED_ARRAY.pop();
  } else {
    throw new Error('Missing . at the end of predicate, or incorrect spacing.');
  }
  return PREPARED_ARRAY;
};

const type_check = (type, object) => {
  const NORMAL_TYPES = ['default', 'bool', 'datetime', 'float', 'geo', 'int', 'password', 'string', 'uid'];
  const LIST_TYPES = ['[default]', '[bool]', '[datetime]', '[float]', '[geo]', '[int]', '[string]', '[uid]'];
  const TYPE_IS_NOT_ALIST = NORMAL_TYPES.some(value => value === type);
  const TYPE_IS_LIST = LIST_TYPES.some(value => value === type);
  if (!TYPE_IS_NOT_ALIST && !TYPE_IS_LIST) {
    throw new Error('Incorrect or missing type in predicate.');
  } else if (TYPE_IS_LIST) {
    object.type = type.slice(1, -1);
  } else {
    object.type = type;
  }
  if (TYPE_IS_LIST) {
    object.list = true;
  }
};

const index_check = (aValues, object) => {
  const TOKENIZER_ARRAY = [];
  const INDEX = aValues.some(value => {
    if (value.includes('@index')) {
      if (value.slice(6, 7) !== '(' || value.slice(-1) !== ')') {
        throw new Error('@index is invalid, missing parenthesis or there are spaces in tokenizer.');
      }
      const FIELDS = value.slice(7, -1).split(',');
      FIELDS.forEach(field => {
        TOKENIZER_ARRAY.push(field.trim());
      });
      return true
    }
    return false
  });
  if (INDEX) {
    object.index = INDEX;
    object.tokenizer = TOKENIZER_ARRAY;
  }
};

const other_options = (aValues, object) => {
  aValues.forEach(value => {
    if (value.includes('@upsert')) {
      object.upsert = true;
    } else if (value.includes('@lang')) {
      object.lang = true;
    }
  })
}

// Create a JSON SCHEMA by using our `SCHEMA` from our file
const create_json_schema = () => {
  const JSON_SCHEMA = [];
  Object.entries(SCHEMA).forEach(([key, value]) => {
    const OBJECT = { predicate: key };
    const PREDICATES_ARRAY = prepare_value_string(value);
    type_check(PREDICATES_ARRAY[0], OBJECT);
    PREDICATES_ARRAY.shift();
    index_check(PREDICATES_ARRAY, OBJECT);
    other_options(PREDICATES_ARRAY, OBJECT);
    JSON_SCHEMA.push(OBJECT);
  });
  return JSON_SCHEMA;
}

const create_json_types = () => {
  const JSON_TYPES = [];
  Object.entries(TYPES).forEach(([key, value]) => {
    const OBJECT = { name: key };
    const FIELDS = [];
    value.forEach(field => {
      FIELDS.push({ name: field })
    });
    OBJECT.fields = FIELDS;
    JSON_TYPES.push(OBJECT);
  });
  return JSON_TYPES;
}

const prepare_json = (json_schema, json_types) => ({
  schema: json_schema,
  types: json_types,
});

const raw_schema = () => {
  let raw_predicates = '';
  Object.entries(SCHEMA).forEach(([key, value]) => {
    raw_predicates += `${key}: ${value}\n`;
  });
  return raw_predicates;
}

const raw_types = () => {
  let raw_types_string = '';
  Object.entries(TYPES).forEach(([key, value]) => {
    let values = '';
    value.forEach(sub_value => {
      values += `\n\t${sub_value}`
    })
    raw_types_string += `\ntype ${key} {${values}\n}`
  });

  return raw_types_string;
}

const remove_dgraph_data = uneprepared_schema => {
  // Removing autogenerated fields by dbgraph
  for (let i = 0; i < uneprepared_schema.schema.length; i++) {
    if (uneprepared_schema.schema[i].predicate === 'dgraph.graphql.schema') {
      uneprepared_schema.schema.splice(i, 1);
      break;
    }
  }
  for (let i = 0; i < uneprepared_schema.schema.length; i++) {
    if (uneprepared_schema.schema[i].predicate === 'dgraph.type') {
      uneprepared_schema.schema.splice(i, 1);
      break;
    }
  }
  // Removing autogenerated types
  for (let i = 0; i < uneprepared_schema.types.length; i++) {
    if (uneprepared_schema.types[i].name === 'dgraph.graphql') {
      uneprepared_schema.types.splice(i, 1);
      break;
    }
  }
}

const compare_predicate_object = (object_a, object_b) => {
  const PREDICATE_A = object_a.predicate.toUpperCase();
  const PREDICATE_B = object_b.predicate.toUpperCase();

  let comparator = 0;
  if (PREDICATE_A > PREDICATE_B) {
    comparator = 1;
  } else if (PREDICATE_A < PREDICATE_B) {
    comparator = -1;
  }
  return comparator;
}

const compare_name_object = (object_a, object_b) => {
  const PREDICATE_A = object_a.name.toUpperCase();
  const PREDICATE_B = object_b.name.toUpperCase();

  let comparator = 0;
  if (PREDICATE_A > PREDICATE_B) {
    comparator = 1;
  } else if (PREDICATE_A < PREDICATE_B) {
    comparator = -1;
  }
  return comparator;
}

const compare_types_fields = (field_a, field_b) => {
  const TYPE_A = field_a.name.toUpperCase();
  const TYPE_B = field_b.name.toUpperCase();

  let comparator = 0;
  if (TYPE_A > TYPE_B) {
    comparator = 1;
  } else if (TYPE_A < TYPE_B) {
    comparator = -1;
  }
  return comparator;
}

class DgraphHelper {
  constructor() {
    this.client_stub = new dgraph.DgraphClientStub('localhost:9080', grpc.credentials.createInsecure());
    this.dgraph_client = new dgraph.DgraphClient(this.client_stub);
  }

  async get_schema() {
    return (await this.dgraph_client.newTxn().query('schema {}')).getJson();
  }

  async get_differences() {
    const JSON_SCHEMA = create_json_schema();
    const JSON_TYPES = create_json_types();
    const NEW_SCHEMA = prepare_json(JSON_SCHEMA, JSON_TYPES);
    const CURRENT_SCHEMA = (await this.dgraph_client.newTxn().query('schema {}')).getJson();
    remove_dgraph_data(CURRENT_SCHEMA);
    NEW_SCHEMA.schema.sort(compare_predicate_object);
    NEW_SCHEMA.types.sort(compare_name_object);
    const DIFFERENCES = diff(NEW_SCHEMA, CURRENT_SCHEMA.types);
    if (typeof DIFFERENCES !== 'undefined') {
      DIFFERENCES.forEach(difference => {
      /* if (['N', 'D', 'E'].includes(difference.kind)) {
        console.log(difference);
      } */
        console.log(difference);
      })
      return DIFFERENCES
    }
    // console.log('No differences between the 2 schemas.');
    return 'No differences between the 2 schemas.';
  }

  async test() {
    const JSON_SCHEMA = create_json_schema();
    const JSON_TYPES = create_json_types();
    const NEW_SCHEMA = prepare_json(JSON_SCHEMA, JSON_TYPES);
    const CURRENT_SCHEMA = (await this.dgraph_client.newTxn().query('schema {}')).getJson();
    remove_dgraph_data(CURRENT_SCHEMA);
    NEW_SCHEMA.schema.sort(compare_predicate_object);
    NEW_SCHEMA.types.sort(compare_name_object);
    CURRENT_SCHEMA.schema.sort(compare_predicate_object);
    CURRENT_SCHEMA.types.sort(compare_name_object);
    const TYPES_TO_CHECK = [];
    const MISSING_TYPES = [];
    NEW_SCHEMA.types.forEach(type => {
      type.fields.sort(compare_types_fields);
      TYPES_TO_CHECK.push(type.name)
    });
    CURRENT_SCHEMA.types.forEach(type => {
      type.fields.sort(compare_types_fields);
      if (!TYPES_TO_CHECK.includes(type.name)) {
        MISSING_TYPES.push(type.name)
      }
    })
    console.log('All types to check', TYPES_TO_CHECK)
    console.log('Missing types in new types', MISSING_TYPES);
    TYPES_TO_CHECK.forEach(type => {
      const NEW_OBJECT = JSON_TYPES.find(object => object.name === type);
      const CURRENT_OBJECT = CURRENT_SCHEMA.types.find(object => object.name === type);
      const DIFFERENCES = diff(CURRENT_OBJECT, NEW_OBJECT); // Can have multiple diff for 1 object
      if (typeof DIFFERENCES !== 'undefined') {
        DIFFERENCES.forEach(difference => {
          if (['N', 'D', 'E'].includes(difference.kind)) {
            console.log(difference);
            if (difference.kind === 'E') {
              console.log('This object was edited at path:', difference.path[0]);
              console.log(CURRENT_OBJECT);
              console.log('Expected', difference.rhs, 'found', difference.lhs)
            } else if (difference.kind === 'N') {
              console.log('This object was added');
              console.log(NEW_OBJECT);
            }
          }
        })
      }
    });
    MISSING_TYPES.forEach(type => {
      const DELETED_OBJECT = CURRENT_SCHEMA.types.find(object => object.name === type);
      console.log('This object has been deleted:');
      console.log(DELETED_OBJECT)
    })
  }


  async alter_schema() {
    const RAW_SCHEMA_STRING = raw_schema();
    const RAW_TYPES_STRING = raw_types();
    const RAW_STRING = `${RAW_TYPES_STRING}\n${RAW_SCHEMA_STRING}`;
    const OPERATION = new dgraph.Operation();
    OPERATION.setSchema(RAW_STRING);
    await this.dgraph_client.alter(OPERATION);
  }
}

export default DgraphHelper;
