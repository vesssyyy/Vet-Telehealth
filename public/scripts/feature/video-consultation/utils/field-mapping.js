export function getMappedFieldValues(fields, getElement = (id) => document.getElementById(id)) {
    return fields.reduce((values, field) => {
        values[field.key] = (getElement(field.id)?.value || '').trim();
        return values;
    }, {});
}

export function setMappedFieldValues(fields, values, getElement = (id) => document.getElementById(id)) {
    if (!values || typeof values !== 'object') return;
    fields.forEach(({ id, key }) => {
        const element = getElement(id);
        if (element && values[key] != null) {
            element.value = String(values[key]);
        }
    });
}

