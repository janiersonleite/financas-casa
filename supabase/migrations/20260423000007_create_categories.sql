-- Tabela de categorias (system defaults user_id=NULL, custom user_id=auth.uid())
CREATE TABLE IF NOT EXISTS categories (
    id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    emoji      VARCHAR(10)  NOT NULL DEFAULT '📦',
    keywords   TEXT[]       NOT NULL DEFAULT '{}',
    type       VARCHAR(10)  NOT NULL DEFAULT 'both'
                   CHECK (type IN ('entrada', 'saida', 'both')),
    sort_order INT          NOT NULL DEFAULT 99,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- Índice único: mesmo nome não pode se repetir por usuário (NULL = sistema)
CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_idx
    ON categories (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::UUID), lower(name));

-- RLS
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categories_select" ON categories FOR SELECT
    USING (user_id IS NULL OR user_id = auth.uid());

CREATE POLICY "categories_insert" ON categories FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "categories_update" ON categories FOR UPDATE
    USING (user_id = auth.uid());

CREATE POLICY "categories_delete" ON categories FOR DELETE
    USING (user_id = auth.uid());

-- Categorias padrão do sistema (user_id = NULL, visíveis para todos)
INSERT INTO categories (user_id, name, emoji, keywords, type, sort_order) VALUES
(NULL, 'Alimentação', '🍔', ARRAY['mercado','supermercado','restaurante','lanche','comida','almoço','jantar','café','cafeteria','hamburguer','pizza','açaí','padaria','ifood','rappi','delivery','marmita','feira','hortifruti','fruta','verdura','pão','salgado','carne','frango','sorvete','bar'], 'saida', 1),
(NULL, 'Transporte',  '🚗', ARRAY['uber','taxi','99','ônibus','onibus','metrô','metro','gasolina','combustível','combustivel','estacionamento','pedágio','pedagio','passagem','mototaxi','cabify'], 'saida', 2),
(NULL, 'Saúde',       '💊', ARRAY['farmácia','farmacia','remédio','remedio','médico','medico','hospital','consulta','dentista','exame','plano','academia','drogaria','vacina','fisioterapia'], 'saida', 3),
(NULL, 'Moradia',     '🏠', ARRAY['aluguel','condomínio','condominio','água','agua','luz','energia','internet','gás','gas','telefone','celular','tv','streaming','netflix','hbo','prime'], 'saida', 4),
(NULL, 'Educação',    '📚', ARRAY['escola','faculdade','curso','livro','mensalidade','apostila','aula','universidade','inglês','ingles','idioma','treinamento'], 'saida', 5),
(NULL, 'Lazer',       '🎮', ARRAY['cinema','show','spotify','youtube','jogo','game','balada','festa','viagem','hotel','passeio','parque','teatro','museu','disney'], 'saida', 6),
(NULL, 'Vestuário',   '👕', ARRAY['roupa','calçado','calcado','tênis','tenis','sapato','camisa','calça','calca','vestido','bermuda','casaco','jaqueta'], 'saida', 7),
(NULL, 'PIX',         '💸', ARRAY['pix','transferência','transferencia','ted','doc'], 'both', 8),
(NULL, 'Salário',     '💰', ARRAY['salário','salario','holerite','vencimento','remuneração','remuneracao','pagamento','freela','freelance'], 'entrada', 9),
(NULL, 'Outros',      '📦', ARRAY[]::TEXT[], 'both', 99)
ON CONFLICT DO NOTHING;
