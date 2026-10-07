CREATE OR REPLACE FUNCTION similar_titles(search_title TEXT, threshold REAL DEFAULT 0.4, days_back INT DEFAULT 2)
RETURNS TABLE(id UUID, title TEXT, similarity REAL) AS $$
BEGIN
  RETURN QUERY
  SELECT a.id, a.title, similarity(a.title, search_title)::REAL
  FROM articles a
  WHERE a.published_at > now() - (days_back || ' days')::INTERVAL
    AND similarity(a.title, search_title) > threshold
  ORDER BY similarity DESC
  LIMIT 20;
END;
$$ LANGUAGE plpgsql;
