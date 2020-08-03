const io = require('socket.io-client')
const kurentoUtils = require('kurento-utils')
require('webrtc-adapter')

//const wsUrl = `https://localhost:3000`
const wsUrl = location.host
const socket = io(wsUrl)
let webRtcPeer

socket.on('connect', () => {
  console.log('connected')
  document.querySelector('#username').innerText = `Your id is ${socket.id}`

})

document.querySelector('#stop-btn').onclick = function () {
  socket.emit('stop-call', {
    data: {
      callerId: socket.id,
      calleeId: document.querySelector('#to').value
    }
  })
}

document.querySelector('#call-btn').onclick = function makeCall() {
  const webRtcPeerOptions = {
    localVideo: document.querySelector('#videoInput'),
    remoteVideo: document.querySelector('#videoOutput'),

    //browser collect ice candidate (network connection)
    onicecandidate: (candidate) =>
      socket.emit('client-send-ice-candidate', {
        data: { candidate },
      }),
  }

  webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(
    webRtcPeerOptions,
    function (err) {
      if (err) return console.error(err)
      this.generateOffer((err, sdp) => {
        if (err) return console.error(err)

        socket.emit('client-make-call', {
          data: {
            sdp,
            callerId: socket.id,
            calleeId: document.querySelector('#to').value,
          },
        })
      })
    }
  )
}

socket.on('client-have-incoming-call', async ({data}) => {
  const webRtcPeerOptions = {
    localVideo: document.querySelector('#videoInput'),
    remoteVideo: document.querySelector('#videoOutput'),

    //browser collect ice candidate (network connection)
    onicecandidate: (candidate) =>
      socket.emit('client-send-ice-candidate', {
        data: { candidate },
      }),
  }

  webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(
    webRtcPeerOptions,
    function (err) {
      if (err) return console.error(err)
      this.generateOffer((err, sdp) => {
        if (err) return console.error(err)

        socket.emit('client-accept-call', {
          data: {
            sdp,
            callerId: data.callerId,
            calleeId: data.calleeId,
          },
        })
      })
    }
  )
})



socket.on('server-send-kurento-candidate', ({data}) => {
  webRtcPeer.addIceCandidate(data.candidate)
})

socket.on('start-communication', ({data}) => {
  webRtcPeer.processAnswer(data.sdp)
})
