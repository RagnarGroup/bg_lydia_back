-- LYD-109: el producto "TEFL England" pasa a llamarse "TEFL BrittanyGroup"
-- (pedido de Dirección, WEB-17). Los leads ya cargados toman el nombre nuevo
-- en programa y en la etiqueta, así los filtros y la deduplicación por
-- programa los siguen encontrando. El historial (LeadActivity) no se toca:
-- registra lo que llegó en su momento.
UPDATE "Lead" SET "programa" = 'TEFL BrittanyGroup'
WHERE "programa" = 'TEFL England';

UPDATE "Lead" SET "tags" = array_replace("tags", 'TEFL_ENGLAND', 'TEFL_BRITTANYGROUP')
WHERE 'TEFL_ENGLAND' = ANY("tags");
