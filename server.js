const https = require('https')
const express = require('express')
const fs = require('fs')
const socketIo = require('socket.io')
const kurento = require('kurento-client')
const path = require('path')
const _ = require('lodash')
const { spawn } = require('child_process')

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
let sessionIndex = 0

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
    const rtpEndpoint = await pipeline.create('RtpEndpoint')
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
    const rtpHubport = await composite.createHubPort()

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
    // await callerWebRtcEndpoint.connect(recorderEndpoint)
    // await recorderEndpoint.record()

    await callerWebRtcEndpoint.connect(callerHubport)
    await calleeWebRtcEndpoint.connect(calleeHubport)
    await recorderHubport.connect(recorderEndpoint)
    await rtpHubport.connect(rtpEndpoint)

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

    const streamPort = 55000 + sessionIndex * 2
    const audioPort = 49170 + sessionIndex * 2
    sessionIndex++ //change to next port
    const streamIp = '127.0.0.1'

    const rtpSdpOffer = generateSdpStreamConfig(streamIp, streamPort, audioPort)
    await rtpEndpoint.processOffer(rtpSdpOffer)

    const rtpSdpFilePath = path.join(
      '/mnt/c/Users/admin/Desktop',
      `${streamIp}_${streamPort}.sdp`
    )
    await fs.promises.writeFile(rtpSdpFilePath, rtpSdpOffer)
    // const childProcess = useFfmpegToPublishRtmp(rtpSdpFilePath)

    // pipeline.childProcess = childProcess

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
    pipeline.childProcess.kill()
    pipeline.release()
  })
})

function generateSdpStreamConfig(nodeStreamIp, port, audioport) {
  //get this value from /etc/kurento/modules/kurento/SdpEndpoint.conf.json
  const audioSampleRate = 22050
  let sdpRtpOfferString = 'v=0\n'

  sdpRtpOfferString += 'o=- 0 0 IN IP4 ' + nodeStreamIp + '\n'
  sdpRtpOfferString += 's=KMS\n'
  sdpRtpOfferString += 'c=IN IP4 ' + nodeStreamIp + '\n'
  sdpRtpOfferString += 't=0 0\n'
  sdpRtpOfferString += 'm=audio ' + audioport + ' RTP/AVP 97\n'
  sdpRtpOfferString += 'a=recvonly\n'
  sdpRtpOfferString += 'a=rtpmap:97 PCMU/' + audioSampleRate + '\n'
  sdpRtpOfferString +=
    'a=fmtp:97 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1508\n'
  sdpRtpOfferString += 'm=video ' + port + ' RTP/AVP 96\n'
  sdpRtpOfferString += 'a=rtpmap:96 H264/90000\n'
  sdpRtpOfferString += 'a=fmtp:96 packetization-mode=1\n'

  return sdpRtpOfferString
}

function useFfmpegToPublishRtmp(rtpSdpFilePath) {
  const rtmpPublishUrl = `rtmp://127.0.0.1:1935/live/${
    path.parse(rtpSdpFilePath).name.replace(/\./g, '_')
  }`
  const command = 'ffmpeg'
  // const args = `-analyzeduration 40M  -protocol_whitelist "file,udp,rtp" -i ${rtpSdpFilePath} -vcodec copy -acodec copy -f flv ${rtmpPublishUrl}`
  // console.log(args)
  const args = [
    '-analyzeduration',
    '40M',
    '-protocol_whitelist',
    'file,udp,rtp',
    '-i',
    rtpSdpFilePath,
    '-vcodec',
    'copy',
    '-acodec',
    'copy',
    '-f',
    'flv',
    rtmpPublishUrl,
  ]
  const child = spawn(command, args)

  // child.stdout.on('close', () => console.log('close stdout'))
  // child.stderr.on('close', () => console.log('close stdout'))

  // child.stdout.pipe(process.stdout)
  // child.stderr.pipe(process.stderr)

  // child.stdout.on('data', (data) => {
  //   console.log(data.toString())
  // })

  // child.stderr.on('data', data => {
  //   console.error(data.toString())
  // })

  // child.on('close', () => {
  //   fs.rmdir(rtpSdpFilePath, () => {})
  // })

  // child.on('disconnect', () => {
  //   fs.rmdir(rtpSdpFilePath, () => {})
  // })

  // child.on('exit', () => {
  //   fs.rmdir(rtpSdpFilePath, () => {})
  // })
  return child
}

app.use('/', express.static('.'))
server.listen(port, () => console.log('server is started on port: ' + port))
