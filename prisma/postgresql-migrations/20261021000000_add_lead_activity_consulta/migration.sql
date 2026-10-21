-- LYD-100: consultas de landing sin visita a sede (Spanish Immersion).
-- Una nueva consulta del mismo email sobre un lead existente queda en el
-- historial con este tipo, en vez de crear un lead duplicado.
ALTER TYPE "LeadActivityType" ADD VALUE IF NOT EXISTS 'consulta';
