/** @type {import('@edge-runtime/vitals').Route} */
export default { async fetch(request) {
  if (request.method !== "POST") return new Response("POST only", {status:405});
  try {
    const {agente, mensagem, historico=[], configuracao={}} = await request.json();
    const MODELS = "@cf/mistralai/mistral-small-3.1-24b-instruct";
    const URL = "https://api.cloudflare.com/client/v4/accounts/1954e6b3a225933ae8793f6f34407043/ai/v1/chat/completions";
    const KEY = process.env.AI_GATEWAY_API_KEY || process.env.CLOUDFLARE_API_TOKEN;

    const RAG = [
      "A bolsa auxílio do Conecta Jovem é de R$ 500,00 por mês durante o curso.",
      "O aluno perde a bolsa se tiver 3 faltas sem justificativa, seguidas ou não.",
      "As aulas são presenciais, das 7h30 às 11h30, no Yumit Hub e na UFMT.",
      "Há vale-transporte (se necessário), auxílio alimentação e material gratuito.",
      "O programa atende jovens de 15 a 24 anos que moram na Baixada Cuiabana.",
      "No Projeto Integrador, cada aluno apresenta um MVP hospedado na nuvem."
    ];

    const SYSTEM = {
      resumidor: "Você é um resumidor. Resuma mensagens em texto legível. Quando o pedido pede JSON, retorne texto normal.",
      tutor: "Você é um tutor de tecnologia. Ensine conceitos de programação e tecnologia de forma clara e didática.",
      analise: "Você é um analista. Analise o tema e retorne: resumo, palavras-chave e nível (iniciante/intermediário/avançado).",
      ferramentas: "Você é um assistente de ferramentas. Use cálculo de média e diferença de datas quando solicitado, senão responda normalmente.",
      conecta: "Você é um assistente do programa Conecta Jovem. Use os dados do programa para responder. Sempre indique que o conhecimento é ilustrativo e não verificado oficialmente.",
      playground:"Você é um assistente versátil. Siga as instruções opcionais do usuário."
    };

    const sys = SYSTEM[agente] || SYSTEM.resumidor;
    let msgs = [{role:"system", content:sys}];

    // filter history: keep only user/assistant, last 12 turns
    const filtered = historico.filter(m=>m.role==="user"||m.role==="assistant").slice(-12);
    msgs = msgs.concat(filtered);
    msgs.push({role:"user", content:mensagem.slice(0,2000)});

    let tools = [];
    if (agente==="ferramentas") {
      tools = [
        {type:"function", function:{name:"calculate_average", description:"Calculate average of numbers", parameters:{type:"object", properties:{numbers:{type:"array",items:{type:"number"}}},required:["numbers"]}}},
        {type:"function", function:{name:"date_difference", description:"Get difference between two dates", parameters:{type:"object", properties:{date1:{type:"string"},date2:{type:"string"}},required:["date1","date2"]}}}
      ];
    }

    if (agente==="conecta") {
      const contexto = RAG.join(" ");
      msgs[0].content = sys + " Contexto baseado em dados do programa (ilustrativo, não verificado oficialmente): " + contexto;
    }

    if (agente==="playground") {
      if (configuracao.prompt) msgs[0].content = configuracao.prompt;
      if (configuracao.temperature) msgs.temperature = configuracao.temperature;
    }

    let jsonBody = {model:MODELS, messages:msgs};
    if (tools.length) jsonBody.tools = tools;
    if (msgs.temperature) jsonBody.temperature = msgs.temperature;

    const resp = await fetch(URL, {
      method:"POST", headers:{"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},
      body:JSON.stringify(jsonBody), signal:AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const er = await resp.text().catch(()=>"");
      return new Response(JSON.stringify({erro:"Erro "+resp.status+": "+er}), {status:resp.status, headers:{"Content-Type":"application/json"}});
    }

    const data = await resp.json();
    let reply = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : "Sem resposta";

    // tool call handling
    if (data.choices && data.choices[0] && data.choices[0].message.tool_calls) {
      const calls = data.choices[0].message.tool_calls;
      const toolResults = [];
      for (const tc of calls) {
        const fn = tc.function.name;
        const args = JSON.parse(tc.function.arguments);
        if (fn==="calculate_average") {
          const avg = args.numbers.reduce((a,b)=>a+b,0) / args.numbers.length;
          toolResults.push({tool_call_id:tc.id, role:"tool", name:fn, content:JSON.stringify({media:avg})});
        } else if (fn==="date_difference") {
          const d1 = new Date(args.date1), d2 = new Date(args.date2);
          const diff = Math.round((d2-d1)/(1000*60*60*24));
          toolResults.push({tool_call_id:tc.id, role:"tool", name:fn, content:JSON.stringify({diferenca_dias:diff})});
        }
      }
      if (toolResults.length) {
        msgs = msgs.concat(data.choices[0].message.tool_calls.map(tc=>({role:"assistant",tool_calls:tc})));
        msgs = msgs.concat(toolResults);
        const r2 = await fetch(URL, {method:"POST",headers:{"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},body:JSON.stringify({model:MODELS,messages:msgs}),signal:AbortSignal.timeout(30000)});
        if (r2.ok) { const d2 = await r2.json(); reply = (d2.choices && d2.choices[0] && d2.choices[0].message.content) || reply; }
      }
    }

    // Format for resumidor and analise
    if (agente==="resumidor") {
      // reply is already human-readable text
    } else if (agente==="analise") {
      try { const parsed = JSON.parse(reply); reply = "Resumo: "+parsed.resumo+" Palavras-chave: "+parsed.palavras_chave.join(", ")+(" Nível: "+parsed.nivel); } catch(e) {}
    }

    return new Response(JSON.stringify({resposta:reply, fontes:[]}), {status:200, headers:{"Content-Type":"application/json"}});
  } catch(err) {
    return new Response(JSON.stringify({erro:err.message||"Erro interno"}), {status:500, headers:{"Content-Type":"application/json"}});
  }
}};
