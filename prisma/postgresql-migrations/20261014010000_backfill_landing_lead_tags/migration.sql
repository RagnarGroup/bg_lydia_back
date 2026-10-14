-- LYD-87: categoria del formulario de origen en los leads de la landing ya existentes.
-- Los de brittanygroup.edu.pe/inscripciones llegaron sin tags; el tag de Au Pair pasa a AUPAIR.

UPDATE "Lead" SET "tags" = array_replace("tags", 'AUPAIR_MIRAFLORES_LANDING', 'AUPAIR')
WHERE 'AUPAIR_MIRAFLORES_LANDING' = ANY("tags");

UPDATE "Lead" SET "tags" = ARRAY['INSCRIPCIONES']::TEXT[]
WHERE "source" = 'landing' AND COALESCE(cardinality("tags"), 0) = 0;
