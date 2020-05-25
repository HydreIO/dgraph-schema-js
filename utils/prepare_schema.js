const prepare_value_string = predicate => {
  if (!predicate.endsWith('.'))
    throw new Error('Missing dot at the end of predicate, or incorrect spacing')


  return predicate.split(' ').slice(0, -1)
}
const type_check = raw_type => {
  const normal_types = [
    'default', 'bool', 'datetime', 'float', 'geo', 'int', 'password', 'string', 'uid',
  ]
  const list_types = [
    '[default]', '[bool]', '[datetime]', '[float]', '[geo]', '[int]', '[string]', '[uid]',
  ]
  const type_is_not_alist = normal_types.some(value => value === raw_type)
  const type_is_list = list_types.some(value => value === raw_type)

  let type = ''
  let list = false

  if (!type_is_not_alist && !type_is_list)
    throw new Error('Incorrect or missing type in predicate.')
  else if (type_is_list) type = raw_type.slice(1, -1)
  else type = raw_type

  if (type_is_list) list = true

  return {
    type,
    list,
  }
}
const index_check = values_array => {
  const tokenizer_array = []
  const index = values_array.some(value => {
    if (value.includes('@index')) {
      if (
        value.slice('@index'.length)[0] !== '('
        || value.slice(-1) !== ')'
      ) {
        throw new Error(`@index is invalid, 
          missing parenthesis or there are spaces in tokenizer.`)
      }

      const fields = value
          .slice('@index('.length, -1)
          .split(',')

      fields.forEach(field => {
        tokenizer_array.push(field.trim())
      })
      return true
    }

    return false
  })

  if (index) {
    return {
      index,
      tokenizer: tokenizer_array,
    }
  }

  return false
}
const other_options = values_array => {
  let upsert = false
  let lang = false

  values_array.forEach(value => {
    if (value.includes('@upsert')) upsert = true
    else if (value.includes('@lang')) lang = true
  })

  return {
    ...upsert && {
      upsert,
    },
    ...lang && {
      lang,
    },
  }
}
const create_json_schema = schema => {
  const json_schema = Object.entries(schema).map(([key, value]) => {
    let evaluated_type = ''
    let evaluated_list = false

    const predicates_array = prepare_value_string(value)

    try {
      const { type, list } = type_check(predicates_array[0])

      evaluated_type = type
      evaluated_list = list
    } catch (error) {
      console.error(error)
    }

    predicates_array.shift()

    let evaluated_index = ''
    let evaluated_token = []

    try {
      const { index, tokenizer } = index_check(predicates_array)

      evaluated_index = index
      evaluated_token = tokenizer
    } catch (error) {
      console.error(error)
    }

    const { options, lang } = other_options(predicates_array)
    const new_object = {
      predicate: key,
      type     : evaluated_type,
      ...evaluated_list && {
        list: evaluated_list,
      },
      ...evaluated_index && {
        index: evaluated_index,
      },
      ...evaluated_token && {
        tokenizer: evaluated_token,
      },
      ...options && {
        options,
      },
      ...lang && {
        lang,
      },
    }

    return new_object
  })

  return json_schema
}
// Custom comparator for sorting our schema
const compare_predicate_object = (object_a, object_b) => {
  const predicate_a = object_a.predicate.toUpperCase()
  const predicate_b = object_b.predicate.toUpperCase()

  return predicate_a.localeCompare(predicate_b)
}
// Custom comparator for sorting types
const compare_name_object = (object_a, object_b) => {
  const predicate_a = object_a.name.toUpperCase()
  const predicate_b = object_b.name.toUpperCase()

  return predicate_a.localeCompare(predicate_b)
}
const create_json_types = types => {
  const json_types = []

  Object.entries(types).forEach(([key, value]) => {
    const object = {
      name: key,
    }
    const fields = value.map(field => ({
      name: field,
    }))

    object.fields = fields
    json_types.push(object)
  })
  return json_types
}
const prepare_new_schema = schema_file => {
  const { schema, types } = schema_file
  const sorted_schema = create_json_schema(schema)
      .sort(compare_predicate_object)
  const sorted_types = create_json_types(types)
      .sort(compare_name_object)

  return {
    schema: sorted_schema,
    types : sorted_types,
  }
}
// Removes Dgraph autogenerated predicates & types
const remove_dgraph_data = pepeg => {
  const schema_filters = new Set([
    'dgraph.graphql.schema', 'dgraph.type',
  ])
  const types_filters = new Set(['dgraph.graphql'])
  const prepared_schema = {
    schema: pepeg.schema.filter(element => {
      if (!schema_filters.has(element.predicate))
        return element
      return false
    }),
    types: pepeg.types.filter(element => {
      if (!types_filters.has(element.name)) return element
      return false
    }),
  }

  return prepared_schema
}
const prepare_current_schema = fetched_schema => {
  const formated_schema = remove_dgraph_data(fetched_schema)

  formated_schema.schema.sort(compare_predicate_object)
  formated_schema.types.sort(compare_name_object)
  return formated_schema
}

export { prepare_new_schema, prepare_current_schema }
