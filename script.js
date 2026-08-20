import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Projeto usado também pelo aplicativo MIT App Inventor.
const SUPABASE_URL = 'https://xllbpyihfjfmtbzcrihs.supabase.co'
const SUPABASE_KEY = 'sb_publishable_l-jesCstcqUQN12aNUgQJg_PkLQHDWm'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

let lixeiras = []
let canalRealtime = null
let pollingId = null
let realtimeAtivo = false

async function init() {
    await carregarDadosIniciais()
    configurarRealtime()
    iniciarPollingDeSeguranca()
}

async function carregarDadosIniciais({ silencioso = false } = {}) {
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
            if (!ultimaPorLixeira.has(String(leitura.lixeira_id))) {
                ultimaPorLixeira.set(String(leitura.lixeira_id), leitura)
            }
        }

        lixeiras = (cadastro || []).map(item => {
            const ultima = ultimaPorLixeira.get(String(item.id))
            return {
                id: item.id,
                nome: item.nome,
                localizacao: item.localizacao,
                altura_cm: normalizarNumero(item.altura_cm, 0),
                percentual: ultima ? normalizarPercentual(ultima.percentual_cheio) : 0,
                atualizado_em: ultima?.criado_em ? new Date(ultima.criado_em) : null
            }
        })

        esconderErro()
        renderizarDashboard()

        if (!silencioso && !realtimeAtivo) {
            atualizarStatusSistema('Sincronizado', 'ok')
        }
    } catch (err) {
        console.error('Erro ao carregar dados:', err)
        mostrarErro(`Falha ao consultar o Supabase: ${err.message || err}`)
        atualizarStatusSistema('Sem conexão', 'erro')
    }
}

function configurarRealtime() {
    if (canalRealtime) {
        supabase.removeChannel(canalRealtime)
    }

    canalRealtime = supabase
        .channel('ecotrack-leituras')
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'leituras'
            },
            payload => processarNovaLeitura(payload.new)
        )
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                realtimeAtivo = true
                atualizarStatusSistema('Tempo real online', 'ok')
                esconderErro()
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                realtimeAtivo = false
                atualizarStatusSistema('Polling ativo', 'aviso')
                mostrarErro('Realtime indisponível. O painel continuará atualizando automaticamente a cada 5 segundos.')
            } else if (status === 'CLOSED') {
                realtimeAtivo = false
                atualizarStatusSistema('Polling ativo', 'aviso')
            }
        })
}

// Garante atualização do GitHub Pages mesmo se a tabela não estiver habilitada no Realtime.
function iniciarPollingDeSeguranca() {
    if (pollingId) clearInterval(pollingId)
    pollingId = setInterval(() => sincronizarUltimasLeituras(), 5000)
}

async function sincronizarUltimasLeituras() {
    try {
        const { data, error } = await supabase
            .from('leituras')
            .select('lixeira_id,percentual_cheio,criado_em')
            .order('criado_em', { ascending: false })
            .limit(Math.max(100, lixeiras.length * 10))

        if (error) throw error

        let mudou = false
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
                mudou = true
            }
        }

        if (mudou) renderizarDashboard()
        if (!realtimeAtivo) atualizarStatusSistema('Polling ativo', 'aviso')
    } catch (err) {
        console.error('Erro no polling:', err)
        mostrarErro(`Falha ao sincronizar leituras: ${err.message || err}`)
        atualizarStatusSistema('Sem conexão', 'erro')
    }
}

function processarNovaLeitura(leitura) {
    const index = lixeiras.findIndex(l => String(l.id) === String(leitura.lixeira_id))

    if (index === -1) {
        carregarDadosIniciais({ silencioso: true })
        return
    }

    atualizarLixeiraComLeitura(index, leitura, true)
    renderizarDashboard()
}

function atualizarLixeiraComLeitura(index, leitura, gerarAlerta) {
    const lixeira = lixeiras[index]
    const nivelAntigo = lixeira.percentual
    const novoNivel = normalizarPercentual(leitura.percentual_cheio)

    lixeira.percentual = novoNivel
    lixeira.atualizado_em = leitura.criado_em ? new Date(leitura.criado_em) : new Date()

    if (gerarAlerta) verificarRegrasDeAlerta(lixeira, nivelAntigo, novoNivel)
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

    if (feed.querySelector('.text-gray-400')) feed.innerHTML = ''

    const configs = {
        danger: {
            card: 'bg-red-50 border-red-200 text-red-800',
            icon: 'fa-triangle-exclamation text-red-500'
        },
        warning: {
            card: 'bg-amber-50 border-amber-200 text-amber-800',
            icon: 'fa-circle-exclamation text-amber-500'
        },
        success: {
            card: 'bg-green-50 border-green-200 text-green-800',
            icon: 'fa-circle-check text-green-500'
        }
    }

    const config = configs[tipo] || configs.warning
    const div = document.createElement('div')
    div.className = `p-3 rounded-lg border flex items-start gap-2.5 shadow-sm animate-slide-in ${config.card}`

    const hora = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    })

    div.innerHTML = `
        <i class="fa-solid ${config.icon} mt-0.5 text-base"></i>
        <div class="flex-1">
            <p class="font-medium">${escapeHtml(mensagem)}</p>
            <span class="text-[10px] opacity-70">${hora}</span>
        </div>
    `

    feed.prepend(div)
}

function renderizarDashboard() {
    calcularEMostrarMetricas()

    const listaContainer = document.getElementById('lista-lixeiras')
    if (!listaContainer) return

    if (lixeiras.length === 0) {
        listaContainer.innerHTML = '<p class="text-gray-500 text-center text-sm py-4">Nenhuma lixeira cadastrada.</p>'
        return
    }

    listaContainer.innerHTML = lixeiras.map(lixeira => {
        let corBarra = 'bg-green-500'
        let corBg = 'bg-green-50'
        let corTexto = 'text-green-700'

        if (lixeira.percentual >= 80) {
            corBarra = 'bg-red-500'
            corBg = 'bg-red-50'
            corTexto = 'text-red-700'
        } else if (lixeira.percentual >= 60) {
            corBarra = 'bg-amber-500'
            corBg = 'bg-amber-50'
            corTexto = 'text-amber-700'
        }

        const ultimaVez = lixeira.atualizado_em
            ? lixeira.atualizado_em.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            : '--:--'

        return `
            <div class="border border-gray-100 rounded-xl p-4 bg-gray-50/50 hover:bg-gray-50 transition-colors">
                <div class="flex justify-between items-start mb-2 gap-4">
                    <div>
                        <h4 class="font-bold text-gray-800">${escapeHtml(lixeira.nome || `Lixeira ${lixeira.id}`)}</h4>
                        <p class="text-xs text-gray-500 flex items-center gap-1">
                            <i class="fa-solid fa-location-dot"></i>
                            ${escapeHtml(lixeira.localizacao || 'Sem local')}
                        </p>
                    </div>
                    <span class="px-2.5 py-1 text-xs font-bold rounded-full ${corBg} ${corTexto}">
                        ${lixeira.percentual}% Cheia
                    </span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-3.5 overflow-hidden shadow-inner">
                    <div class="${corBarra} h-3.5 rounded-full transition-all duration-500 ease-out" style="width: ${lixeira.percentual}%"></div>
                </div>
                <div class="flex justify-between text-[11px] text-gray-400 mt-2 gap-4">
                    <span>Altura cadastrada: ${lixeira.altura_cm || 0} cm</span>
                    <span>Último sinal: ${ultimaVez}</span>
                </div>
            </div>
        `
    }).join('')
}

function calcularEMostrarMetricas() {
    const total = lixeiras.length
    const criticas = lixeiras.filter(l => l.percentual >= 80).length
    const somaPercentuais = lixeiras.reduce((acc, l) => acc + l.percentual, 0)
    const media = total > 0 ? Math.round(somaPercentuais / total) : 0

    const datas = lixeiras
        .map(l => l.atualizado_em)
        .filter(d => d instanceof Date && !Number.isNaN(d.getTime()))

    const maisRecente = datas.length > 0
        ? new Date(Math.max(...datas.map(d => d.getTime())))
        : null

    document.getElementById('metric-total').innerText = total
    document.getElementById('metric-criticas').innerText = criticas
    document.getElementById('metric-media').innerText = `${media}%`
    document.getElementById('metric-tempo').innerText = maisRecente
        ? maisRecente.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '--:--'

    document.getElementById('qtd-alertas').innerText = criticas
    const badge = document.getElementById('badge-alertas')

    if (criticas > 0) {
        badge.className = 'flex items-center gap-1.5 bg-red-50 text-red-700 px-3 py-1.5 rounded-full border border-red-200 font-bold animate-bounce'
    } else {
        badge.className = 'flex items-center gap-1.5 bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full border border-gray-200'
    }
}

function atualizarStatusSistema(texto, tipo) {
    const status = document.getElementById('status-sistema')
    const dot = document.getElementById('status-dot')
    const label = document.getElementById('status-texto')
    if (!status || !dot || !label) return

    const estilos = {
        ok: {
            status: 'flex items-center gap-1.5 bg-green-50 text-green-700 px-3 py-1.5 rounded-full border border-green-200',
            dot: 'h-2.5 w-2.5 bg-green-500 rounded-full animate-pulse'
        },
        aviso: {
            status: 'flex items-center gap-1.5 bg-amber-50 text-amber-700 px-3 py-1.5 rounded-full border border-amber-200',
            dot: 'h-2.5 w-2.5 bg-amber-500 rounded-full animate-pulse'
        },
        erro: {
            status: 'flex items-center gap-1.5 bg-red-50 text-red-700 px-3 py-1.5 rounded-full border border-red-200',
            dot: 'h-2.5 w-2.5 bg-red-500 rounded-full'
        }
    }

    const config = estilos[tipo] || estilos.aviso
    status.className = config.status
    dot.className = config.dot
    label.innerText = texto
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
