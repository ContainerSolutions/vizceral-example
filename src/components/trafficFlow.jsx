'use strict';
import _ from 'lodash';
import { Alert } from 'react-bootstrap';
import React from 'react';
import TWEEN from 'tween.js'; // Start TWEEN updates for sparklines and loading screen fading out
import Vizceral from 'vizceral-react';
import 'vizceral-react/dist/vizceral.css';
import keypress from 'keypress.js';
import queryString from 'query-string';
import request from 'superagent';
import Influx from 'influx';
import cors from 'cors';


import Breadcrumbs from './breadcrumbs';
import DetailsPanelConnection from './detailsPanelConnection';
import DetailsPanelNode from './detailsPanelNode';
import LoadingCover from './loadingCover';
import UpdateStatus from './updateStatus';

import filterActions from './filterActions';
import filterStore from './filterStore';

const listener = new keypress.Listener();

const influx = new Influx.InfluxDB({
  host: '104.199.47.18',
  database: 'k8s'
})

function animate (time) {
  requestAnimationFrame(animate);
  TWEEN.update(time);
}
requestAnimationFrame(animate);

const panelWidth = 400;

class TrafficFlow extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      currentView: undefined,
      redirectedFrom: undefined,
      selectedChart: undefined,
      displayOptions: {
        showLabels: true
      },
      labelDimensions: {},
      appliedFilters: filterStore.getChangedFilters(),
      filters: filterStore.getFiltersArray(),
      graphs: { regions: {} },
      renderedGraphs: {},
      searchTerm: '',
      matches: {
        total: -1,
        visible: -1
      },
      trafficData: {
        nodes: [],
        connections: []
      },
      regionUpdateStatus: [],
      timeOffset: 0,
      modes: {
        detailedNode: 'volume'
      },
      secondsElapsed: 0
    };

    // Browser history support
    window.addEventListener('popstate', event => this.handlePopState(event.state));

    // Keyboard interactivity
    listener.simple_combo('esc', () => {
      if (this.state.detailedNode) {
        this.setState({ detailedNode: undefined });
      } else if (this.state.currentView.length > 0) {
        this.setState({ currentView: this.state.currentView.slice(0, -1) });
      }
    });
  }

  handlePopState () {
    const state = window.history.state || {};
    this.poppedState = true;
    this.setState({ currentView: state.selected, objectToHighlight: state.highlighted });
  }

  viewChanged = (data) => {
    this.setState({ currentView: data.view, currentGraph: data.graph, searchTerm: '', matches: { total: -1, visible: -1 }, redirectedFrom: data.redirectedFrom });
  }

  objectHighlighted = (highlightedObject) => {
    // need to set objectToHighlight for diffing on the react component. since it was already highlighted here, it will be a noop
    this.setState({ highlightedObject: highlightedObject, objectToHighlight: highlightedObject ? highlightedObject.getName() : undefined, searchTerm: '', matches: { total: -1, visible: -1 }, redirectedFrom: undefined });
  }

  rendered = (data) => {
    const renderedGraphs = _.clone(this.state.renderedGraphs);
    renderedGraphs[data.name] = data.rendered;
    this.setState({ renderedGraphs: renderedGraphs });
  }

  nodeFocused = (node) => {
    this.setState({ focusedNode: node });
  }

  nodeContextSizeChanged = (dimensions) => {
    this.setState({ labelDimensions: dimensions });
  }

  checkInitialRoute () {
    // Check the location bar for any direct routing information
    const pathArray = window.location.pathname.split('/');
    const currentView = [];
    if (pathArray[1]) {
      currentView.push(pathArray[1]);
      if (pathArray[2]) {
        currentView.push(pathArray[2]);
      }
    }
    const parsedQuery = queryString.parse(window.location.search);

    this.setState({ currentView: currentView, objectToHighlight: parsedQuery.highlighted });
  }

  beginReadData () {
    this.traffic = { nodes: [], connections: [] };

    var query = "select mean(value) as \"network/rx_rate\" from \"network/rx_rate\" \
       where type = 'pod' and time > now() - 1m \
       group by hostname, pod_name, time(1m) limit 1";

    var proxy = 'http://localhost:3000/?url=';
    var db = 'k8s';
    var url = 'http://104.199.47.18:8086/query?';
    url += '&db=' + encodeURIComponent(db);
    url += '&q=' + encodeURIComponent(query);

    var finalUrl = proxy + encodeURIComponent(url);

    console.log("Final " + finalUrl);
    var that = this;
    $.ajax({
        type: "GET",
        url: finalUrl,
        data: {},
        xhrFields: {
            withCredentials: false
        },
        crossDomain: true,
        dataType: 'json',
        success: function(data, textStatus, jqXHR) {
          var res = that.produceVizceralUpdate(data);
          console.log(res);
          that.updateData(res);
        }
    });

    /*
    influx.query(`
      `).then(result => {
        //res.json(result)
        console.log(result);
      }).catch(err => {
              console.log("Error");

        //res.status(500).send(err.stack)
      })
     */


    /* request.get('sample_data.json')
      .set('Accept', 'application/json')
      .end((err, res) => {
        if (res && res.status === 200) {
          this.traffic.clientUpdateTime = Date.now();
          this.updateData(res.body);
        }
      });
      */
  }

  produceVizceralUpdate(data) {
    var result = {
      "renderer": "global",
      "name": "edge",
      "nodes": [
        {
          "renderer": "region",
          "name": "INTERNET",
          "class": "normal"
        }],
      "connections": []
    };

    var detailed = {};

    $.each(data.results[0].series, function( key, value ) {

      var updated = Date.now();
      function updateStats(stats, region, pod, value) {
        if(!(region in stats)) {
          stats[region] = {};
        }
        if(!(pod in stats[region])) {
          stats[region][pod] = {};
        }
        for(var i = 0; i< value.columns.length; i++) {
          stats[region][pod][value.columns[i]] = value.values[0][i];
        }
      }
      var re_gce = /^gke-gce-(.*)-default-pool-.*$/;
      var re_aws = /^ip-.*$/;

      var found;
      var str = value.tags.hostname;
      if ((found = str.match(re_gce))!== null) {
        var region = found[1];
        updateStats(detailed, region, value.tags.pod_name, value);
      } else if ((found = str.match(re_aws))!== null) {
        updateStats(detailed, "aws", value.tags.pod_name, value);
      } else {
        console.log("No match found");
      }

      for(var region in detailed) {
        var reg = {
          "renderer": "region",
          "name": region,
          "maxVolume": 50000,
          "class": "normal",
          "updated": updated,
          "nodes": [
            {
              "name": "INTERNET",
              "class": "normal"
            }
          ],
          "connections": []
        };
        for(var pod in detailed[region]) {
          reg.nodes.push({
              "name": pod,
              "class": "normal"
            }
          );
        }
        var sumRegionRx = 0;
        for(var pod in detailed[region]) {
          reg.nodes.push({
              "name": pod,
              "class": "normal"
            }
          );
          var podRx = detailed[region][pod]['network/rx_rate'];
          sumRegionRx += podRx;
          reg.connections.push({
            "source": "INTERNET",
            "target": pod,
            "metrics": {
               "danger": 0,
               "normal": podRx
            },
          "class": "normal"
          });
        }
        result.nodes.push(reg);
        result.connections.push({
          "source": "INTERNET",
          "target": region,
          "metrics": {
            "normal": sumRegionRx,
            "danger": 0
          },
          "notices": [
          ],
          "class": "normal"
        });
      }
    });
      console.log(result);
    return result;
  }


  componentDidMount () {
    this.checkInitialRoute();
    // this.beginSampleData();
    this.interval = setInterval(() => this.beginReadData(), 1000);

    // Listen for changes to the stores
    filterStore.addChangeListener(this.filtersChanged);
  }

  componentWillUnmount () {
    filterStore.removeChangeListener(this.filtersChanged);
  }

  shouldComponentUpdate (nextProps, nextState) {
    if (!this.state.currentView ||
        this.state.currentView[0] !== nextState.currentView[0] ||
        this.state.currentView[1] !== nextState.currentView[1] ||
        this.state.highlightedObject !== nextState.highlightedObject) {
      const titleArray = (nextState.currentView || []).slice(0);
      titleArray.unshift('Vizceral');
      document.title = titleArray.join(' / ');

      if (this.poppedState) {
        this.poppedState = false;
      } else if (nextState.currentView) {
        const highlightedObjectName = nextState.highlightedObject && nextState.highlightedObject.getName();
        const state = {
          title: document.title,
          url: nextState.currentView.join('/') + (highlightedObjectName ? `?highlighted=${highlightedObjectName}` : ''),
          selected: nextState.currentView,
          highlighted: highlightedObjectName
        };
        window.history.pushState(state, state.title, state.url);
      }
    }
    return true;
  }

  updateData (newTraffic) {
    const updatedTraffic = {
      name: newTraffic.name,
      renderer: newTraffic.renderer,
      nodes: [],
      connections: []
    };

    _.each(this.state.trafficData.nodes, node => updatedTraffic.nodes.push(node));
    _.each(this.state.trafficData.connections, connection => updatedTraffic.connections.push(connection));

    let modified = false;
    if (newTraffic) {
      modified = true;
      // Update the traffic graphs with the new state
      _.each(newTraffic.nodes, (node) => {
        const existingNodeIndex = _.findIndex(updatedTraffic.nodes, { name: node.name });
        if (existingNodeIndex !== -1) {
          if (node.nodes && node.nodes.length > 0) {
            node.updated = node.updated || updatedTraffic.nodes[existingNodeIndex].updated;
            updatedTraffic.nodes[existingNodeIndex] = node;
          }
        } else {
          updatedTraffic.nodes.push(node);
        }
      });
      _.each(newTraffic.connections, (connection) => {
        const existingConnectionIndex = _.findIndex(updatedTraffic.connections, { source: connection.source, target: connection.target });
        if (existingConnectionIndex !== -1) {
          updatedTraffic.connections[existingConnectionIndex] = connection;
        } else {
          updatedTraffic.connections.push(connection);
        }
      });
    }

    if (modified) {
      const regionUpdateStatus = _.map(_.filter(updatedTraffic.nodes, n => n.name !== 'INTERNET'), (node) => {
        const updated = node.updated;
        return { region: node.name, updated: updated };
      });
      const lastUpdatedTime = _.max(_.map(regionUpdateStatus, 'updated'));
      this.setState({
        regionUpdateStatus: regionUpdateStatus,
        timeOffset: newTraffic.clientUpdateTime - newTraffic.serverUpdateTime,
        lastUpdatedTime: lastUpdatedTime,
        trafficData: updatedTraffic
      });
    }
  }

  isFocusedNode () {
    return !this.isSelectedNode()
      && this.state.currentView
      && this.state.currentView[0] !== undefined
      && this.state.focusedNode !== undefined;
  }

  isSelectedNode () {
    return this.state.currentView && this.state.currentView[1] !== undefined;
  }

  zoomCallback = () => {
    const currentView = _.clone(this.state.currentView);
    if (currentView.length === 1 && this.state.focusedNode) {
      currentView.push(this.state.focusedNode.name);
    } else if (currentView.length === 2) {
      currentView.pop();
    }
    this.setState({ currentView: currentView });
  }

  displayOptionsChanged = (options) => {
    const displayOptions = _.merge({}, this.state.displayOptions, options);
    this.setState({ displayOptions: displayOptions });
  }

  navigationCallback = (newNavigationState) => {
    this.setState({ currentView: newNavigationState });
  }

  detailsClosed = () => {
    // If there is a selected node, deselect the node
    if (this.isSelectedNode()) {
      this.setState({ currentView: [this.state.currentView[0]] });
    } else {
      // If there is just a detailed node, remove the detailed node.
      this.setState({ focusedNode: undefined, highlightedObject: undefined });
    }
  }

  filtersChanged = () => {
    this.setState({
      appliedFilters: filterStore.getChangedFilters(),
      filters: filterStore.getFiltersArray()
    });
  }

  filtersCleared = () => {
    if (!filterStore.isClear()) {
      if (!filterStore.isDefault()) {
        filterActions.resetFilters();
      } else {
        filterActions.clearFilters();
      }
    }
  }

  locatorChanged = (value) => {
    this.setState({ searchTerm: value });
  }

  chartChanged = (chartName) => {
    this.setState({ selectedChart: chartName });
  }

  matchesFound = (matches) => {
    this.setState({ matches: matches });
  }

  graphsUpdated = (graphs) => {
    this.setState({ graphs: graphs });
  }

  nodeClicked = (node) => {
    if (this.state.currentView.length === 1) {
      // highlight node
      this.setState({ objectToHighlight: node.getName() });
    } else if (this.state.currentView.length === 2) {
      // detailed view of node
      this.setState({ currentView: [this.state.currentView[0], node.getName()] });
    }
  }

  dismissAlert = () => {
    this.setState({ redirectedFrom: undefined });
  }

  render () {
    const globalView = this.state.currentView && this.state.currentView.length === 0;
    const nodeView = !globalView && this.state.currentView && this.state.currentView[1] !== undefined;
    const nodeToShowDetails = this.state.focusedNode || (this.state.highlightedObject && this.state.highlightedObject.type === 'node' ? this.state.highlightedObject : undefined);
    const connectionToShowDetails = this.state.highlightedObject && this.state.highlightedObject.type === 'connection' ? this.state.highlightedObject : undefined;
    const showLoadingCover = !!(this.state.currentView && this.state.currentView[0] && !this.state.renderedGraphs[this.state.currentView[0]]);

    return (
      <div className="vizceral-container">
        { this.state.redirectedFrom ?
          <Alert onDismiss={this.dismissAlert}>
            <strong>{this.state.redirectedFrom.join('/') || '/'}</strong> does not exist, you were redirected to <strong>{this.state.currentView.join('/') || '/'}</strong> instead
          </Alert>
        : undefined }
        <div className="subheader">
          <Breadcrumbs rootTitle="global" navigationStack={this.state.currentView || []} navigationCallback={this.navigationCallback} />
          <UpdateStatus status={this.state.regionUpdateStatus} baseOffset={this.state.timeOffset} warnThreshold={180000} />
        </div>
        <div className="service-traffic-map">
          <div style={{ position: 'absolute', top: '0px', right: nodeToShowDetails || connectionToShowDetails ? '380px' : '0px', bottom: '0px', left: '0px' }}>
            <Vizceral traffic={this.state.trafficData}
                      view={this.state.currentView}
                      showLabels={this.state.displayOptions.showLabels}
                      filters={this.state.filters}
                      graphsUpdated={this.graphsUpdated}
                      viewChanged={this.viewChanged}
                      objectHighlighted={this.objectHighlighted}
                      rendered={this.rendered}
                      nodeFocused={this.nodeFocused}
                      nodeContextSizeChanged={this.nodeContextSizeChanged}
                      objectToHighlight={this.state.objectToHighlight}
                      matchesFound={this.matchesFound}
                      match={this.state.searchTerm}
                      modes={this.state.modes}
            />
          </div>
          {
            !!nodeToShowDetails &&
            <DetailsPanelNode node={nodeToShowDetails}
                              nodeSelected={nodeView}
                              region={this.state.currentView[0]}
                              width={panelWidth}
                              zoomCallback={this.zoomCallback}
                              closeCallback={this.detailsClosed}
                              nodeClicked={node => this.nodeClicked(node)}
            />
          }
          {
            !!connectionToShowDetails &&
            <DetailsPanelConnection connection={connectionToShowDetails}
                                    region={this.state.currentView[0]}
                                    width={panelWidth}
                                    closeCallback={this.detailsClosed}
                                    nodeClicked={node => this.nodeClicked(node)}
            />
          }
          <LoadingCover show={showLoadingCover} />
        </div>
      </div>
    );
  }
}

TrafficFlow.propTypes = {
};

export default TrafficFlow;
