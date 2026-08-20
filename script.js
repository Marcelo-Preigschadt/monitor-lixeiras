import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://xllbpyihfjfmtbzcrihs.supabase.co'
const SUPABASE_KEY = 'sb_publishable_l-jesCstcqUQN12aNUgQJg_PkLQHDWm'
const LIMITE_SENSOR_ONLINE_MS = 15000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

let lixeiras = []
let canalRealtime = null
let pollingId = null
let bancoDisponivel = false

async function init() {
    await carregarDadosIniciais()
    configurarRealtime()
    iniciarPollingDeSeguranca()
}

async function carregarDadosIniciais() {
    try {
        const { data: cadastro, error: erroLixeiras } = await supabase
            .from('lixeiras')
            .select('id,nome,localizacao,altura_cm')
            .order('id', { ascending: true })

        if (erroLixeiras) throw erroLixeiras

        const { data: leituras, error: erroLeituras } = await supabase
            .from('leituras')
            .select('lixeira_id,percentual_cheio,criado_em')
            .order('criado_em', { ascending: false })
            .limit(500)

        if (erroLeituras) throw erroLeituras

        const ultimaPorLixeira = new Map()
        for (const leitura of leituras || []) {
            const chave = String(leitura.lixeira_id)
            if (!ultimaPorLixeira.has(chave)) ultimaPorLixeira.set(chave, leitura)
        }

        lixeiras = (cadastro || []).map(item => {
            const ultima = ultimaPorLixeira.get(String(item.id))
            return {
                id: item.id,
                nome: item.nome,
                localizacao: item.localizacao,
                altura_cm: normalizarNumero(item.altura_cm, 0),
                percentual: ultima ? normalizarPercentual(ultima.percentual_cheio) : null,
                atualizado_em: ultima?.criado_em ? new Date(ultima.criado_em) : null
            }
        })

        bancoDisponivel = true
        esconderErro()
        renderizarDashboard()
    } catch (err) {
        bancoDisponivel = false
        console.error('Erro ao carregar dados:', err)
        mostrarErro(`Falha ao consultar o Supabase: ${err.message || err}`)
        atualizarStatusSistema('Banco indisponível', 'erro')
    }
}

function configurarRealtime() {
    if (canalRealtime) supabase.removeChannel(canalRealtime)

    canalRealtime = supabase
        .channel('ecotrack-leituras')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'leituras' },
            payload => processarNovaLeitura(payload.new)
        )
        .subscribe(status => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn('Realtime indisponível; polling de 5 s permanece ativo.')
            }
        })
}

function iniciarPollingDeSeguranca() {
    if (pollingId) clearInterval(pollingId)
    pollingId = setInterval(sincronizarUltimasLeituras, 5000)
}

async function sincronizarUltimasLeituras() {
    try {
        const { data, error } = await supabase
            .from('leituras')
            .select('lixeira_id,percentual_cheio,criado_em')
            .order('criado_em', { ascending: false })
            .limit(Math.max(100, lixeiras.length * 10))

        if (error) throw error

        bancoDisponivel = true
        esconderErro()

        const maisRecentes = new Map()
        for (const leitura of data || []) {
            const chave = String(leitura.lixeira_id)
            if (!maisRecentes.has(chave)) maisRecentes.set(chave, leitura)
        }

        for (const [chave, leitura] of maisRecentes) {
            const index = lixeiras.findIndex(l => String(l.id) === chave)
            if (index === -1) continue

            const dataNova = leitura.criado_em ? new Date(leitura.criado_em) : null
            const dataAtual = lixeiras[index].atualizado_em

            if (!dataAtual || (dataNova && dataNova > dataAtual)) {
                atualizarLixeiraComLeitura(index, leitura, true)
            }
        }

        renderizarDashboard()
    } catch (err) {
        bancoDisponivel = false
        console.error('Erro no polling:', err)
        mostrarErro(`Falha ao sincronizar leituras: ${err.message || err}`)
        atualizarStatusSistema('Banco indisponível', 'erro')
    }
}

function processarNovaLeitura(leitura) {
    bancoDisponivel = true
    const index = lixeiras.findIndex(l => String(l.id) === String(leitura.lixeira_id))

    if (index === -1) {
        carregarDadosIniciais()
        return
    }

    atualizarLixeiraComLeitura(index, leitura, true)
    renderizarDashboard()
}

function atualizarLixeiraComLeitura(index, leitura, gerarAlerta) {
    const lixeira = lixeiras[index]
    const estavaOnline = sensorEstaOnline(lixeira)
    const nivelAntigo = lixeira.percentual
    const novoNivel = normalizarPercentual(leitura.percentual_cheio)

    lixeira.percentual = novoNivel
    lixeira.atualizado_em = leitura.criado_em ? new Date(leitura.criado_em) : new Date()

    if (gerarAlerta && estavaOnline && nivelAntigo !== null) {
        verificarRegrasDeAlerta(lixeira, nivelAntigo, novoNivel)
    }
}

function sensorEstaOnline(lixeira) {
    const data = lixeira?.atualizado_em
    if (!(data instanceof Date) || Number.isNaN(data.getTime())) return false

    const idade = Date.now() - data.getTime()
    return idade >= -60000 && idade <= LIMITE_SENSOR_ONLINE_MS
}

function verificarRegrasDeAlerta(lixeira, antigo, novo) {
    let msg = ''
    let tipo = ''

    if (novo >= 80 && antigo < 80) {
        msg = `A lixeira "${lixeira.nome}" atingiu nível crítico (${novo}%).`
        tipo = 'danger'
    } else if (novo < 20 && antigo >= 70) {
        msg = `A lixeira "${lixeira.nome}" foi esvaziada.`
        tipo = 'success'
    } else if (novo >= 60 && antigo < 60) {
        msg = `A lixeira "${lixeira.nome}" está enchendo (${novo}%).`
        tipo = 'warning'
    }

    if (msg) adicionarAlertaNoFeed(msg, tipo)
}

function adicionarAlertaNoFeed(mensagem, tipo) {
    const feed = document.getElementById('feed-alertas')
    if (!feed) return

    if (feed.querySelector('.empty-alerts')) feed.innerHTML = ''

    const configs = {
        danger: { classe: 'event-danger', icon: 'fa-triangle-exclamation' },
        warning: { classe: 'event-warning', icon: 'fa-circle-exclamation' },
        success: { classe: 'event-success', icon: 'fa-circle-check' }
    }

    const config = configs[tipo] || configs.warning
    const div = document.createElement('div')
    div.className = `event-card ${config.classe}`

    const hora = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    })

    div.innerHTML = `
        <div class="event-icon"><i class="fa-solid ${config.icon}"></i></div>
        <div><strong>${escapeHtml(mensagem)}</strong></div>
        <time>${hora}</time>
    `

    feed.prepend(div)
}

function renderizarDashboard() {
    calcularEMostrarMetricas()
    atualizarStatusDosSensores()

    const listaContainer = document.getElementById('lista-lixeiras')
    if (!listaContainer) return

    if (lixeiras.length === 0) {
        listaContainer.innerHTML = '<div class="loading-state">Nenhuma lixeira cadastrada.</div>'
        return
    }

    listaContainer.innerHTML = lixeiras.map(lixeira => {
        const online = sensorEstaOnline(lixeira)
        const percentual = lixeira.percentual ?? 0
        const nivelVisual = online ? percentual : 0
        const livre = online ? 100 - percentual : null

        let classeNivel = 'is-low'
        let estado = 'Online'
        let descricao = `${livre}% de capacidade livre`

        if (!online) {
            classeNivel = 'is-offline'
            estado = 'Offline'
            descricao = lixeira.percentual !== null
                ? `Última leitura registrada: ${percentual}%`
                : 'Aguardando a primeira leitura do sensor'
        } else if (percentual >= 80) {
            classeNivel = 'is-critical'
            descricao = 'Nível crítico — esvaziamento recomendado'
        } else if (percentual >= 60) {
            classeNivel = 'is-medium'
            descricao = 'Atenção — lixeira se aproximando do limite'
        }

        const ultimoSinal = formatarDataHora(lixeira.atualizado_em)
        const valorPrincipal = online ? percentual : '--'

        return `
            <article class="bin-card ${classeNivel}" style="--level:${nivelVisual}%">
                <div class="bin-visual-area">
                    <div class="bin-lid"></div>
                    <div class="bin-body" aria-label="${online ? `${percentual}% ocupada` : 'Sensor offline'}">
                        <div class="bin-fill"></div>
                        <div class="bin-scale" aria-hidden="true"><span></span><span></span><span></span></div>
                        <div class="bin-offline-label">SEM SINAL</div>
                    </div>
                    <div class="bin-visual-caption">Nível físico estimado</div>
                </div>

                <div class="bin-info">
                    <div class="bin-status-row">
                        <span class="bin-status">${estado}</span>
                        <span class="bin-id">Lixeira #${escapeHtml(lixeira.id)}</span>
                    </div>

                    <h3>${escapeHtml(lixeira.nome || `Lixeira ${lixeira.id}`)}</h3>
                    <div class="bin-location">
                        <i class="fa-solid fa-location-dot"></i>
                        <span>${escapeHtml(lixeira.localizacao || 'Local não informado')}</span>
                    </div>

                    <div class="level-display">
                        <strong>${valorPrincipal}</strong><span>%</span>
                    </div>
                    <p class="level-description">${escapeHtml(descricao)}</p>

                    <div class="bin-meta">
                        <div class="meta-item">
                            <span>Altura cadastrada</span>
                            <strong>${lixeira.altura_cm || 0} cm</strong>
                        </div>
                        <div class="meta-item">
                            <span>Último sinal</span>
                            <strong>${ultimoSinal}</strong>
                        </div>
                    </div>
                </div>
            </article>
        `
    }).join('')
}

function calcularEMostrarMetricas() {
    const online = lixeiras.filter(sensorEstaOnline)
    const total = lixeiras.length
    const criticas = online.filter(l => (l.percentual ?? 0) >= 80).length
    const media = online.length > 0
        ? Math.round(online.reduce((acc, l) => acc + (l.percentual ?? 0), 0) / online.length)
        : null

    const datasOnline = online
        .map(l => l.atualizado_em)
        .filter(d => d instanceof Date && !Number.isNaN(d.getTime()))

    const maisRecenteOnline = datasOnline.length > 0
        ? new Date(Math.max(...datasOnline.map(d => d.getTime())))
        : null

    document.getElementById('metric-total').innerText = total
    document.getElementById('metric-criticas').innerText = criticas
    document.getElementById('metric-media').innerText = media === null ? '--' : `${media}%`
    document.getElementById('metric-tempo').innerText = maisRecenteOnline
        ? maisRecenteOnline.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : 'Sem sinal'

    document.getElementById('qtd-alertas').innerText = criticas
    const badge = document.getElementById('badge-alertas')
    badge?.classList.toggle('has-alerts', criticas > 0)
}

function atualizarStatusDosSensores() {
    if (!bancoDisponivel) {
        atualizarStatusSistema('Banco indisponível', 'erro')
        return
    }

    const online = lixeiras.filter(sensorEstaOnline).length
    if (online === 0) {
        atualizarStatusSistema('Nenhum sensor online', 'offline')
    } else if (online === 1) {
        atualizarStatusSistema('1 sensor online', 'ok')
    } else {
        atualizarStatusSistema(`${online} sensores online`, 'ok')
    }
}

function atualizarStatusSistema(texto, tipo) {
    const status = document.getElementById('status-sistema')
    const label = document.getElementById('status-texto')
    if (!status || !label) return

    status.classList.remove('is-ok', 'is-offline', 'is-error')
    status.classList.add(tipo === 'ok' ? 'is-ok' : tipo === 'erro' ? 'is-error' : 'is-offline')
    label.innerText = texto
}

function formatarDataHora(data) {
    if (!(data instanceof Date) || Number.isNaN(data.getTime())) return 'Nunca'
    return data.toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
}

function mostrarErro(mensagem) {
    const box = document.getElementById('erro-conexao')
    if (!box) return
    box.textContent = mensagem
    box.classList.remove('hidden')
}

function esconderErro() {
    const box = document.getElementById('erro-conexao')
    if (!box) return
    box.classList.add('hidden')
    box.textContent = ''
}

function normalizarNumero(valor, fallback = 0) {
    const numero = Number(valor)
    return Number.isFinite(numero) ? numero : fallback
}

function normalizarPercentual(valor) {
    const numero = Math.round(normalizarNumero(valor, 0))
    return Math.max(0, Math.min(100, numero))
}

function escapeHtml(valor) {
    return String(valor ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
}

window.addEventListener('load', init)
