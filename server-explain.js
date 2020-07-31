const https = require('https')
const express = require('express')
const fs = require('fs')
const socketIo = require('socket.io')
const { promisify } = require('util')
const kurento = require('kurento-client')

const port = 3000
const kurentoUrl = 'ws://localhost:8888/kurento'
const httpsOption = {
  key: fs.readFileSync('./keys/server.key'),
  cert: fs.readFileSync('./keys/server.crt'),
}
const app = express()
const server = https.createServer(httpsOption, app)
const io = socketIo(server)
const sessionStore = []
const candidateStore = {}

io.on('connection', async (socket) => {
  const kurentoClient = await promisify(kurento).bind(kurento)(kurentoUrl)
  sessionStore.push({
    id: socket.id,
    socket,
    pipeline: null,
    webRtcEndpoint: null,
    sdp: null,
  })

  socket.on('client-make-call', async ({ data }) => {
    const { callerId, calleeId } = data
    const caller = sessionStore.find((i) => i.id === callerId)
    const callee = sessionStore.find((i) => i.id === calleeId)

    caller.sdp = data.sdp
    callee.socket.emit('client-have-incoming-call', {
      data: { calleeId, callerId },
    })
  })

  socket.on('client-accept-call', async ({ data }) => {
    const { callerId, calleeId } = data
    const caller = sessionStore.find((i) => i.id === callerId)
    const callee = sessionStore.find((i) => i.id === calleeId)
    callee.sdp = data.sdp

    const pipeline = await promisify(kurentoClient.create).bind(kurentoClient)(
      'MediaPipeline'
    )
    const calleeWebRtcEndpoint = await promisify(pipeline.create).bind(
      pipeline
    )('WebRtcEndpoint')
    const callerWebRtcEndpoint = await promisify(pipeline.create).bind(
      pipeline
    )('WebRtcEndpoint')

    // still not guarantee webRtcEndpoint can add all candidate
    // demo only
    while (candidateStore[calleeId]?.length) {
      const candidate = candidateStore[calleeId].shift()
      calleeWebRtcEndpoint.addIceCandidate(candidate)
    }

    // still not guarantee webRtcEndpoint can add all candidate
    // demo only
    while (candidateStore[callerId]?.length) {
      const candidate = candidateStore[callerId].shift()
      callerWebRtcEndpoint.addIceCandidate(candidate)
    }

    //server collect icd candidate
    calleeWebRtcEndpoint.on('OnIceCandidate', (evt) => {
      const candidate = kurento.getComplexType('IceCandidate')(evt.candidate)
      callee.socket.emit('server-send-kurento-candidate', {
        data: { candidate },
      })
    })

    //server collect icd candidate
    callerWebRtcEndpoint.on('OnIceCandidate', (evt) => {
      const candidate = kurento.getComplexType('IceCandidate')(evt.candidate)
      caller.socket.emit('server-send-kurento-candidate', {
        data: { candidate },
      })
    })

    await promisify(calleeWebRtcEndpoint.connect).bind(calleeWebRtcEndpoint)(
      callerWebRtcEndpoint
    )
    await promisify(callerWebRtcEndpoint.connect).bind(callerWebRtcEndpoint)(
      calleeWebRtcEndpoint
    )

    caller.webRtcEndpoint = callerWebRtcEndpoint
    callee.webRtcEndpoint = calleeWebRtcEndpoint

    const callerAnswerSdp = await promisify(
      callerWebRtcEndpoint.processOffer
    ).bind(callerWebRtcEndpoint)(caller.sdp)

    await promisify(callerWebRtcEndpoint.gatherCandidates).bind(
      callerWebRtcEndpoint
    )()

    const calleeAnswerSdp = await promisify(
      calleeWebRtcEndpoint.processOffer
    ).bind(calleeWebRtcEndpoint)(callee.sdp)

    await promisify(calleeWebRtcEndpoint.gatherCandidates).bind(
      calleeWebRtcEndpoint
    )()

    caller.socket.emit('start-communication', {
      data: { sdp: callerAnswerSdp },
    })
    callee.socket.emit('start-communication', {
      data: { sdp: calleeAnswerSdp },
    })
  })

  socket.on('client-send-ice-candidate', async ({ data }) => {
    const candidate = kurento.getComplexType('IceCandidate')(data.candidate)
    const { webRtcEndpoint } = sessionStore.find((i) => i.id === socket.id)

    // add canidate immediately
    if (webRtcEndpoint) webRtcEndpoint.addIceCandidate(candidate)
    //queue canidate and add when endpoint is ready
    else if (!candidateStore[socket.id]) candidateStore[socket.id] = [candidate]
    else candidateStore[socket.id].push(candidate)
  })
})

app.use('/', express.static('.'))
server.listen(port, () => console.log('server is started on port: ' + port))
