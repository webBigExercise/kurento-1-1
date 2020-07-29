const https = require('https')
const express = require('express')
const fs = require('fs')
const socketIo = require('socket.io')
const kurento = require('kurento-client')
const _ = require('lodash')

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
const candidateReady = {}

io.on('connection', async (socket) => {
  const kurentoClient = await kurento(kurentoUrl)
  sessionStore.push({
    id: socket.id,
    socket,
    pipelines: [],
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

    const pipeline = await kurentoClient.create('MediaPipeline')
    const calleeWebRtcEndpoint = await pipeline.create('WebRtcEndpoint')
    const callerWebRtcEndpoint = await pipeline.create('WebRtcEndpoint')
    const recorderEndpoint = await pipeline.create('RecorderEndpoint', {
      // mediaProfile: 'MP4',
      uri:
        'file:///tmp/video-' +
        callerId +
        '--------to-------' +
        calleeId +
        '.webm',
    })

    pipeline.recorderEndpoint = recorderEndpoint
    caller.pipelines.push(pipeline)
    callee.pipelines.push(pipeline)

    const composite = await pipeline.create('Composite')
    const callerHubport = await composite.createHubPort()
    const calleeHubport = await composite.createHubPort()
    const recorderHubport = await composite.createHubPort()

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

    await calleeWebRtcEndpoint.connect(callerWebRtcEndpoint)
    await callerWebRtcEndpoint.connect(calleeWebRtcEndpoint)
    await callerWebRtcEndpoint.connect(recorderEndpoint)
    // await recorderEndpoint.record()

    // await recorderHubport.connect(recorderEndpoint)
    // await callerWebRtcEndpoint.connect(callerHubport)
    // await calleeWebRtcEndpoint.connect(calleeHubport)
    // await callerHubport.connect(callerWebRtcEndpoint)
    // await calleeHubport.connect(calleeWebRtcEndpoint)

    callerWebRtcEndpoint.on('OnIceGatheringDone', async (error) => {
      candidateReady[callerId] = true
      if (candidateReady[calleeId]) {
        recorderEndpoint.record()
      }
    })
    calleeWebRtcEndpoint.on('OnIceGatheringDone', async (error) => {
      candidateReady[calleeId] = true
      if (candidateReady[callerId]) {
        recorderEndpoint.record()
      }
    })

    caller.webRtcEndpoint = callerWebRtcEndpoint
    callee.webRtcEndpoint = calleeWebRtcEndpoint

    const callerAnswerSdp = await callerWebRtcEndpoint.processOffer(caller.sdp)
    await callerWebRtcEndpoint.gatherCandidates()

    const calleeAnswerSdp = await calleeWebRtcEndpoint.processOffer(callee.sdp)
    await calleeWebRtcEndpoint.gatherCandidates()

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

  socket.on('stop-call', async ({ data }) => {
    const { callerId, calleeId } = data
    const caller = sessionStore.find((i) => i.id === callerId)
    const callee = sessionStore.find((i) => i.id === calleeId)
    const [pipeline] = _.intersection(caller.pipelines, callee.pipelines)

    if (!pipeline || !pipeline.recorderEndpoint) return

    pipeline.recorderEndpoint.stop()
    pipeline.release()
  })
})

app.use('/', express.static('.'))
server.listen(port, () => console.log('server is started on port: ' + port))
