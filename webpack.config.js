const path = require('path');
const webpack = require('webpack');
// const DashboardPlugin = require('webpack-dashboard/plugin')
// const UglifyJsPlugin = require('uglifyjs-webpack-plugin')

module.exports = {
    //entry: path.join(__dirname, 'src', 'index.js'),
    entry: path.join(__dirname, 'client.js'),
    output: {
        filename: 'client.build.js',
        //path: path.resolve(__dirname, 'public')
        path: path.join(__dirname),
        // publicPath: './static'
    },
    resolve: {
        extensions: ['.json', '.js', '.jsx', '.css']
    },
    devtool: 'source-map',
    mode: 'development'
};